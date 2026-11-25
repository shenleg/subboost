// 组装订阅管理、公开 YAML、订阅源导入及安全设置端点。
import { Hono } from "hono";
import type { WorkerApp } from "../env";

/** 挂在 `/api` 下；覆盖 `/subscriptions`、`/source-import` 和 `/settings/source-import`。 */
export const subscriptionRoutes = new Hono<WorkerApp>();
