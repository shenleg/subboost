// 组装规则搜索、中文候选与识别端点。
import { Hono } from "hono";
import type { WorkerApp } from "../env";

/** 挂在 `/api` 下的 `/rules/*` 路由。 */
export const ruleRoutes = new Hono<WorkerApp>();
