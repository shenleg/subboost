// 在 Vitest 的 Node 进程中直调 Worker，同时使用真实的本地 D1。
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { nowMs, type WorkerBindings } from "../src/env";
import worker from "../src/index";

type FixtureOptions = {
  bindings?: Partial<Omit<WorkerBindings, "DB">>;
  migrate?: boolean;
};
const configPath = fileURLToPath(new NodeURL("../../wrangler.jsonc", import.meta.url));
const migrationsDir = new NodeURL("../migrations/", import.meta.url);

/**
 * 建立独立、非持久化的 Worker 测试环境。
 * @param options 覆盖绑定、时钟和外部传输；可跳过迁移以测试未初始化的数据库。
 * @returns 顶层 HTTP/Cron 调用、真实 D1 和需释放的夹具，建议用 `await using`。
 * @throws Wrangler 启动或 SQL 迁移失败时抛出。
 */
export async function createWorkerFixture(options: FixtureOptions = {}) {
  const platform = await getPlatformProxy<Pick<WorkerBindings, "DB">>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const db = platform.env.DB;
  const env: WorkerBindings = {
    DB: db,
    ...options.bindings,
    // 未声明的回源应令测试失败，而不是访问真实服务。
    fetch: options.bindings?.fetch ?? (async () => {
      throw new Error("测试未提供外部 fetch 响应");
    }),
  };
  try {
    if (options.migrate !== false) await applyMigrations(db);
  } catch (error) {
    await platform.dispose();
    throw error;
  }

  return {
    db,
    env,
    request: (path: string, init?: RequestInit) =>
      worker.fetch(new Request(new URL(path, "https://subboost.test"), init), env, platform.ctx),
    async scheduled(cron: string, scheduledTime = nowMs(env)) {
      const pending: Promise<unknown>[] = [];
      // Wrangler 的测试上下文不会等待 waitUntil；测试需等任务完成后再读 D1。
      const ctx: ExecutionContext = Object.assign(Object.create(platform.ctx), {
        waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      });
      await worker.scheduled({ cron, scheduledTime, noRetry() {} }, env, ctx);
      await Promise.all(pending);
    },
    [Symbol.asyncDispose]: platform.dispose,
  };
}

/**
 * 在 D1 上按文件名顺序原子执行每份 SQL 迁移。
 * @param db 本次测试的空白本地 D1。
 * @returns 所有迁移应用后的完成信号。
 * @throws 无法读取迁移文件或迁移执行失败时抛出。
 */
async function applyMigrations(db: D1Database) {
  for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = await readFile(new NodeURL(file, migrationsDir), "utf8");
    // 与 Wrangler 使用相同的 SQL 分割器，保留字符串及触发器里的分号。
    const statements = unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement));
    await db.batch(statements);
  }
}
