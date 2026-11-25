// 执行订阅 Cron 批次，按版本与租约发布快照或保留可跨轮的刷新进度。
import { decryptEncryptedFieldV2, encryptEncryptedFieldV2 } from "@subboost/server-core/crypto";
import {
  applyCronUpdateOutcome, createCronUpdateAccumulator, extractHostsFromSubscriptionUrls, finalizeCronUpdateSummary,
  recordCronUpdateSkipped, resolveAutomaticRefreshCompletionDecision, resolveAutomaticRefreshFailureAnalysis,
  resolveAutomaticRefreshUnexpectedFailureCompletion, resolveAutoUpdateScheduleState, resolveSubscriptionAutoUpdateState,
  type CronUpdateOutcome,
} from "@subboost/server-core/subscription";
import { SUBSCRIPTION_MAX_PROFILE_REQUESTS } from "@subboost/server-core/subscription/snapshot-comparison";
import { nowMs, type WorkerBindings } from "./env";
import {
  acquireSubscriptionCronLease, cleanExpiredCronRecords, readCronBatch, readCronCheckpoint, SubscriptionCronLeaseLostError,
  writeCronCheckpoint, writeCronSweep, type SubscriptionCronLease,
} from "./subscription-cron-store";
import { buildSubscriptionFetchCallbacks, MAX_NODES_PER_SUBSCRIPTION, prepareSubscriptionRefresh } from "./subscription-refresh";
import { commitSubscriptionRefresh, readSubscription, readSubscriptionSecrets, type SubscriptionRow } from "./subscription-store";
import { createExternalTransport, ExternalFetchBudgetExceededError, MAX_FETCHES_PER_REQUEST, type ExternalFetchBudget } from "./transport";

const DEFAULT_BATCH_SIZE = 3;
// 每条订阅需要候选复读、检查点查询和最多两条提交语句；为租约、进度和清理留足 D1 查询额度。
const MAX_BATCH_SIZE = 5;

function batchSize(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

type Callbacks = ReturnType<typeof buildSubscriptionFetchCallbacks>;
type NodeResult = Awaited<ReturnType<Callbacks["fetchUrlNodes"]>>;
type InfoResult = Awaited<ReturnType<Callbacks["fetchUrlUserInfo"]>>;
type Checkpoint = { nodes: [string, NodeResult][]; userInfo: [string, NonNullable<InfoResult> | null][] };

function resumableCallbacks(checkpoint: Checkpoint, live: Callbacks, budget: ExternalFetchBudget, lease: SubscriptionCronLease) {
  const nodes = new Map(checkpoint.nodes);
  const userInfo = new Map(checkpoint.userInfo);
  const replayed = nodes.size + userInfo.size;
  const callbacks: Callbacks = {
    async fetchUrlNodes(source) {
      const saved = nodes.get(source.id);
      if (saved) return saved;
      await lease.maintain();
      // 一次节点回调可能发出全部 UA 请求及一次补充 HEAD，且每个请求可能重定向。
      // 先确认整段能运行，确保打断时只有已完成的结果可重放，不会从同一个请求中途反复重来。
      const supplemental = source.userinfoUrl || source.userinfoUserAgent ? 1 : 0;
      if (budget.remaining < (SUBSCRIPTION_MAX_PROFILE_REQUESTS + supplemental) * MAX_FETCHES_PER_REQUEST) {
        throw new ExternalFetchBudgetExceededError();
      }
      const result = await live.fetchUrlNodes(source);
      budget.throwIfDenied();
      nodes.set(source.id, result);
      return result;
    },
    async fetchUrlUserInfo(source) {
      if (!source.userinfoUrl) return undefined;
      if (userInfo.has(source.id)) return userInfo.get(source.id) ?? undefined;
      await lease.maintain();
      if (budget.remaining < MAX_FETCHES_PER_REQUEST) throw new ExternalFetchBudgetExceededError();
      const result = await live.fetchUrlUserInfo(source);
      budget.throwIfDenied();
      userInfo.set(source.id, result ?? null);
      return result;
    },
  };
  return {
    callbacks,
    progressed: () => nodes.size + userInfo.size > replayed,
    serialize: () => JSON.stringify({ nodes: [...nodes], userInfo: [...userInfo] } satisfies Checkpoint),
  };
}

type RefreshResult =
  | { kind: "finished"; outcome?: CronUpdateOutcome }
  | { kind: "storage_limit" }
  | { kind: "budget_deferred"; progressed: boolean };

async function refreshOne(env: WorkerBindings, lease: SubscriptionCronLease, row: SubscriptionRow, username: string,
  key: string, live: Callbacks, budget: ExternalFetchBudget): Promise<RefreshResult> {
  const state = resolveSubscriptionAutoUpdateState(row);
  const target = { id: row.id, name: row.name, userId: row.ownerId, username, autoUpdateInterval: row.autoUpdateInterval };
  const attemptedAt = new Date(nowMs(env));
  const ciphertext = await readCronCheckpoint(env, row);
  const checkpoint: Checkpoint = ciphertext ? JSON.parse(decryptEncryptedFieldV2(ciphertext, key)) : { nodes: [], userInfo: [] };
  const replay = resumableCallbacks(checkpoint, live, budget, lease);
  async function markStorageLimit(): Promise<RefreshResult> {
    return await writeCronCheckpoint(env, lease, row, null) === "storage_limit" ? { kind: "storage_limit" } : { kind: "finished" };
  }
  let requestedHosts: string[] = [];
  let prepared: Awaited<ReturnType<typeof prepareSubscriptionRefresh>>;
  try {
    const secrets = readSubscriptionSecrets(row, key);
    requestedHosts = extractHostsFromSubscriptionUrls(secrets.urls);
    prepared = await prepareSubscriptionRefresh(secrets, replay.callbacks);
  } catch (error) {
    if (error instanceof SubscriptionCronLeaseLostError) throw error;
    if (error instanceof ExternalFetchBudgetExceededError) {
      if (!replay.progressed()) return { kind: "budget_deferred", progressed: false };
      const result = await writeCronCheckpoint(env, lease, row, encryptEncryptedFieldV2(replay.serialize(), key));
      if (result === "storage_limit") return { kind: "storage_limit" };
      if (result === "stale") return { kind: "finished" };
      return { kind: "budget_deferred", progressed: true };
    }
    // 不回传解密错误或上游异常原文，避免在运行记录中暴露订阅源凭据。
    const completion = resolveAutomaticRefreshUnexpectedFailureCompletion({ target, requestedHosts,
      error: new Error("Subscription refresh failed"), attemptStartedAt: attemptedAt, currentAutoUpdateState: state });
    await lease.maintain();
    const result = await commitSubscriptionRefresh(env.DB, { row, key, lease, now: nowMs(env), state: completion.attemptedState });
    if (result === "storage_limit") return markStorageLimit();
    return { kind: "finished", outcome: result === "committed" ? completion.outcome : undefined };
  }
  const failure = resolveAutomaticRefreshFailureAnalysis({ currentState: state, snapshot: prepared.snapshot, failedAt: attemptedAt });
  await lease.maintain();
  const now = nowMs(env);
  const decision = resolveAutomaticRefreshCompletionDecision({ target, currentAutoUpdateState: state,
    prepared: { requestedHosts, refreshResult: prepared.refreshResult, ...failure }, attemptedAt,
    maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION, successAttemptedAt: new Date(now) });
  const next = decision.kind === "empty_result" ? undefined : decision.nextAutoUpdateState;
  const result = await commitSubscriptionRefresh(env.DB, { row, key, lease, now,
    cache: decision.kind === "success" ? decision.refreshResult : undefined,
    state: decision.kind === "empty_result" ? decision.attemptedState : next?.state,
    autoUpdateInterval: next?.shouldDisableAutoUpdate ? null : undefined,
  });
  if (result === "storage_limit") return markStorageLimit();
  return { kind: "finished", outcome: result === "committed" ? decision.outcome : undefined };
}

/**
 * 执行同一任务租约保护的有限订阅批次；只向调用者报告已落库的刷新结果。
 * @param env D1、批次配置、时钟与外部传输。
 * @param key 非空的订阅字段加密密钥。
 * @param budget 本次 Cron 独立的外部 fetch 额度。
 * @returns 原版摘要及本次预算/容量让位计数，或者已有调用在运行的跳过结果。
 * @throws 租约失效或 D1 请求失败时抛出。
 */
export async function runSubscriptionCron(env: WorkerBindings, key: string, budget: ExternalFetchBudget) {
  const lease = await acquireSubscriptionCronLease(env);
  if (!lease) return { success: true, skipped: true, reason: "already_running" } as const;
  try {
    const limit = batchSize(env.CRON_BATCH_SIZE);
    const { startedAt, candidates } = await readCronBatch(env, limit + 1);
    const accumulator = createCronUpdateAccumulator(0);
    const live = buildSubscriptionFetchCallbacks(createExternalTransport(env, { budget }));
    let budgetDeferred = 0;
    let storageLimited = 0;
    let visited = 0;
    for (const candidate of candidates.slice(0, limit)) {
      await lease.maintain();
      const row = await readSubscription(env.DB, candidate.ownerId, candidate.id);
      accumulator.results.total++;
      if (!row || row.autoUpdateInterval === null || !resolveAutoUpdateScheduleState({
        createdAt: row.createdAt, lastUpdatedAt: row.lastUpdatedAt, lastAttemptedAt: row.autoUpdateState?.lastAttemptedAt,
        now: new Date(startedAt), intervalSeconds: Math.max(360, row.autoUpdateInterval),
      }).due) {
        recordCronUpdateSkipped(accumulator);
        visited++;
        continue;
      }
      const result = await refreshOne(env, lease, row, candidate.username, key, live, budget);
      if (result.kind === "finished" && result.outcome) applyCronUpdateOutcome(accumulator, result.outcome);
      else recordCronUpdateSkipped(accumulator);
      if (result.kind === "storage_limit") storageLimited++;
      if (result.kind === "budget_deferred") {
        budgetDeferred++;
        // 只给有进度的大订阅让位，空跑的候选应留在队首，拿到下一轮的完整预算。
        if (result.progressed) visited++;
        break;
      }
      visited++;
    }
    const last = candidates[visited - 1];
    if (last || candidates.length === 0) {
      await writeCronSweep(env, lease, last && candidates.length > visited
        ? { startedAt, afterTime: last.sortTime, afterId: last.id } : null);
    }
    await cleanExpiredCronRecords(env, lease);
    return { success: true, ...finalizeCronUpdateSummary(accumulator, { maxTopHosts: 50, maxTopUsers: 50 }),
      budgetDeferred, storageLimited, timestamp: new Date(nowMs(env)).toISOString() } as const;
  } finally {
    // 释放失败时由 TTL 接管；绝不能让旧调用释放新持有者的租约，或覆盖原任务异常。
    await lease.release().catch(() => undefined);
  }
}
