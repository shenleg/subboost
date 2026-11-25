// 组装模板列表、详情、上传和删除端点。
import { Hono } from "hono";
import type { WorkerApp } from "../env";

/** 挂在 `/api` 下的 `/templates` 与 `/templates/:id` 路由。 */
export const templateRoutes = new Hono<WorkerApp>();
