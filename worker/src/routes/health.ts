// 提供无需会话的存活和就绪检查。
import { Hono } from "hono";
import { ENCRYPTION_KEY_MISSING, getEncryptionKey, type WorkerApp } from "../env";

/** 挂在 `/api` 下的 Worker 健康检查路由。 */
export const healthRoutes = new Hono<WorkerApp>()
  .get("/health/live", (c) => c.json({ ok: true, service: "subboost-worker" }))
  .get("/health/ready", async (c) => {
    if (!getEncryptionKey(c.env)) return c.json({ ok: false, ...ENCRYPTION_KEY_MISSING }, 503);
    try {
      // 除了连通性，还应确认初始化所需的迁移已经应用；空管理员表也算就绪。
      await c.env.DB.prepare("SELECT id FROM LocalAdmin LIMIT 1").first();
      return c.json({ ok: true, database: "ready" });
    } catch {
      return c.json({ ok: false, database: "unavailable" }, 503);
    }
  });
