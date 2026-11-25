// 组装管理员初始化与会话端点（/setup/admin、/auth/*）。
import { Hono } from "hono";
import type { WorkerApp } from "../env";

/** 挂在 `/api` 下的初始化与认证路由；认证守卫由此域提供给管理路由。 */
export const authRoutes = new Hono<WorkerApp>();
