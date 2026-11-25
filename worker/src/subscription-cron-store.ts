// 管理订阅 Cron 的 D1 任务租约和有界、公平的到期扫描。
import { nowMs, type WorkerBindings } from "./env";
import type { SubscriptionRow } from "./subscription-store";

const LEASE_NAME = "local-subscription-auto-update";
// 对齐原版的五分钟租期；共享导入单次回调的请求超时短于租期。
const LEASE_MS = 5 * 60_000;
const RENEW_AFTER_MS = 60_000;

/** 旧调用失去租约时阻止后续写入，由 HTTP 和 scheduled 分别报告。 */
export class SubscriptionCronLeaseLostError extends Error {
  constructor() {
    super("Local subscription update lease lost.");
    this.name = "SubscriptionCronLeaseLostError";
  }
}

/**
 * 原子抢占订阅 Cron 的租约；活动租约不可覆盖。
 * @param env 提供 D1 及当前时间。
 * @returns 未获锁时为 null；获锁后可检查、续期和按持有者释放。
 * @throws D1 请求失败，或 `maintain` 发现租约失效时抛出。
 */
export async function acquireSubscriptionCronLease(env: WorkerBindings) {
  const { DB } = env;
  const ownerToken = crypto.randomUUID();
  let renewedAt = nowMs(env);
  const acquired = await DB.prepare(`INSERT INTO JobLeaseLock (name, ownerToken, expiresAt, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET ownerToken = excluded.ownerToken, expiresAt = excluded.expiresAt, updatedAt = excluded.updatedAt
    WHERE JobLeaseLock.expiresAt <= excluded.updatedAt RETURNING ownerToken`)
    .bind(LEASE_NAME, ownerToken, renewedAt + LEASE_MS, renewedAt).first();
  if (!acquired) return null;
  return {
    name: LEASE_NAME,
    ownerToken,
    async maintain() {
      const now = nowMs(env);
      if (now >= renewedAt + LEASE_MS) throw new SubscriptionCronLeaseLostError();
      if (now < renewedAt + RENEW_AFTER_MS) return;
      const renewed = await DB.prepare(`UPDATE JobLeaseLock SET expiresAt = ?, updatedAt = ?
        WHERE name = ? AND ownerToken = ? AND expiresAt > ? RETURNING ownerToken`)
        .bind(now + LEASE_MS, now, LEASE_NAME, ownerToken, now).first();
      if (!renewed) throw new SubscriptionCronLeaseLostError();
      renewedAt = now;
    },
    async release() {
      await DB.prepare("DELETE FROM JobLeaseLock WHERE name = ? AND ownerToken = ?").bind(LEASE_NAME, ownerToken).run();
    },
  };
}

/** 每次 Cron 取得的租约句柄；业务写入也须检查它的身份，而不能只依靠 `maintain`。 */
export type SubscriptionCronLease = NonNullable<Awaited<ReturnType<typeof acquireSubscriptionCronLease>>>;

type Sweep = { startedAt: number; afterTime: number; afterId: string };
type Candidate = { id: string; ownerId: string; username: string; sortTime: number };

/**
 * 按原版到期分桶和最久未更新顺序读取少量候选，不加载加密订阅数据。
 * @param env 提供 D1 与当前时间。
 * @param limit 最多读取的候选数（包含调用方用于识别下一批的探针）。
 * @returns 本趟到期基准时间和有序候选。
 * @throws D1 读失败时抛出。
 */
export async function readCronBatch(env: WorkerBindings, limit: number) {
  const { DB } = env;
  const sweep = await DB.prepare("SELECT startedAt, afterTime, afterId FROM SubscriptionCronSweep WHERE id = 1 AND startedAt IS NOT NULL").first<Sweep>();
  const now = nowMs(env);
  async function read(startedAt: number, cursor: Sweep | null) {
    // 与共享到期算法一致：从创建时间分桶，而非在上次尝试后重新计时。
    const rows = await DB.prepare(`SELECT s.id, s.ownerId, u.username, COALESCE(s.lastUpdatedAt, s.createdAt) AS sortTime
      FROM Subscription s JOIN LocalAdmin u ON u.id = s.ownerId
      LEFT JOIN SubscriptionAutoUpdateState a ON a.subscriptionId = s.id
      WHERE s.autoUpdateInterval IS NOT NULL AND s.createdAt <= ?
        AND (CAST(? AS INTEGER) - s.createdAt) / (MAX(s.autoUpdateInterval, 360) * 1000) >
          (MAX(s.createdAt, COALESCE(s.lastUpdatedAt, s.createdAt), COALESCE(a.lastAttemptedAt, s.createdAt)) - s.createdAt)
            / (MAX(s.autoUpdateInterval, 360) * 1000)
        AND NOT EXISTS (SELECT 1 FROM SubscriptionCronProgress p WHERE p.subscriptionId = s.id
          AND p.revision = s.revision AND p.part = -1 AND p.expiresAt > ?)
        ${cursor ? "AND (COALESCE(s.lastUpdatedAt, s.createdAt), s.id) > (?, ?)" : ""}
      ORDER BY COALESCE(s.lastUpdatedAt, s.createdAt), s.id LIMIT ?`)
      .bind(startedAt, startedAt, now, ...(cursor ? [cursor.afterTime, cursor.afterId] : []), limit).all<Candidate>();
    return { startedAt, candidates: rows.results };
  }
  const batch = await read(sweep?.startedAt ?? now, sweep);
  // 扫描期间剩余项可能被编辑或删除；此时无需等一整个 Cron 周期再回头。
  return sweep && !batch.candidates.length ? read(now, null) : batch;
}

/**
 * 保存本趟已给过机会的扫描位置；完成本趟时清除。SQL 同时验证租约归属和有效期。
 * @param env 提供 D1 与提交时间。
 * @param lease 当前调用的租约。
 * @param next 待续扫描位置；为 null 时回到队首。
 * @throws 租约失效或 D1 写入失败时抛出。
 */
export async function writeCronSweep(env: WorkerBindings, lease: SubscriptionCronLease, next: Sweep | null) {
  await lease.maintain();
  const saved = await env.DB.prepare(`INSERT INTO SubscriptionCronSweep (id, startedAt, afterTime, afterId)
    SELECT 1, ?, ?, ? WHERE EXISTS (${activeLease}) ON CONFLICT(id) DO UPDATE SET
      startedAt = excluded.startedAt, afterTime = excluded.afterTime, afterId = excluded.afterId RETURNING id`)
    .bind(next?.startedAt ?? null, next?.afterTime ?? null, next?.afterId ?? null, lease.name, lease.ownerToken, nowMs(env)).first();
  if (!saved) throw new SubscriptionCronLeaseLostError();
}

const activeLease = "SELECT 1 FROM JobLeaseLock WHERE name = ? AND ownerToken = ? AND expiresAt > ?";
// 保留一天供多轮接力，并用同一时长冷却 D1 无法写入的版本；管理员编辑后立即生效。
const PROGRESS_TTL_MS = 24 * 60 * 60_000;
// D1 每行最多 2 MB；最多 4 片控制检查点读写及单次 D1 查询数。
const PART_SIZE = 1_500_000;
const MAX_PARTS = 4;

/**
 * 加载仍有效的同版本检查点密文；不会读取其他版本或容量冷却标记。
 * @param env 当前 D1 与时间。
 * @param row 当前读取的订阅版本。
 * @returns 可解密的完整密文；不存在时返回空字符串。
 * @throws D1 读失败时抛出。
 */
export async function readCronCheckpoint(env: WorkerBindings, row: SubscriptionRow) {
  const { results } = await env.DB.prepare(`SELECT payload FROM SubscriptionCronProgress
    WHERE subscriptionId = ? AND revision = ? AND part >= 0 AND expiresAt > ? ORDER BY part`)
    .bind(row.id, row.revision, nowMs(env)).all<{ payload: string }>();
  return results.map(({ payload }) => payload).join("");
}

/**
 * 原子保存仍由本调用持有的当前版本检查点；不改订阅缓存或失败状态。
 * @param env 当前 D1 与时间。
 * @param lease 当前调用的租约。
 * @param row 检查点对应的冻结订阅版本。
 * @param ciphertext 仅接受加密结果；null 或超出容量时改为同版本冷却标记。
 * @returns 保存成功的类型，或版本/租约已过时。
 * @throws 租约失效或 D1 写入失败时抛出。
 */
export async function writeCronCheckpoint(env: WorkerBindings, lease: SubscriptionCronLease, row: SubscriptionRow,
  ciphertext: string | null) {
  const hasCheckpoint = ciphertext !== null && ciphertext.length <= PART_SIZE * MAX_PARTS;
  const parts: (string | null)[] = [];
  if (hasCheckpoint) {
    for (let start = 0; start < ciphertext.length; start += PART_SIZE) parts.push(ciphertext.slice(start, start + PART_SIZE));
  } else parts.push(null);
  await lease.maintain();
  const now = nowMs(env);
  const put = env.DB.prepare(`INSERT INTO SubscriptionCronProgress (subscriptionId, revision, part, payload, expiresAt)
    SELECT id, revision, ?, ?, ? FROM Subscription WHERE id = ? AND revision = ? AND EXISTS (${activeLease})
    ON CONFLICT(subscriptionId, revision, part) DO UPDATE SET payload = excluded.payload, expiresAt = excluded.expiresAt`);
  const [saved] = await env.DB.batch(parts.map((part, index) => put.bind(part === null ? -1 : index, part, now + PROGRESS_TTL_MS,
    row.id, row.revision, lease.name, lease.ownerToken, now)));
  if (!saved?.meta.changes) return "stale";
  return hasCheckpoint ? "saved" : "storage_limit";
}


// 限制单轮行写入数，留给正常回源与管理员请求足够的每日 D1 配额。
const CLEANUP_LIMIT = 20;

/**
 * 顺带删除少量过期的认证及 Cron 运行记录，绝不清理仍有效的记录。
 * @param env 当前 D1 和时钟。
 * @param lease 当前调用的租约。
 * @throws 租约失效或 D1 写入失败时抛出。
 */
export async function cleanExpiredCronRecords(env: WorkerBindings, lease: SubscriptionCronLease) {
  await lease.maintain();
  const now = nowMs(env);
  const tables = [["RevokedSession", "expiresAt"], ["AuthRateLimit", "resetAt"],
    ["SubscriptionCronProgress", "expiresAt"]] as const;
  await env.DB.batch(tables.map(([table, expiry]) => env.DB.prepare(`DELETE FROM ${table}
    WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${expiry} <= ? ORDER BY ${expiry} LIMIT ?)
      AND EXISTS (${activeLease})`).bind(now, CLEANUP_LIMIT, lease.name, lease.ownerToken, now)));
  await lease.maintain();
}
