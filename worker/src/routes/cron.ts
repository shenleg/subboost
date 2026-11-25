// 组装原生 Cron 和可选的 HTTP 手动触发端点。
import { Hono } from "hono";
import type { WorkerApp, WorkerBindings } from "../env";

/** 挂在 `/api` 下的 `/cron/*` 路由，与原生触发复用任务实现。 */
export const cronRoutes = new Hono<WorkerApp>();

/**
 * 原生 Cron 调度接缝；任务 runner 接入前不执行任何任务。
 * @param controller 当前 Cron 表达式及调度时间。
 * @param env 当前 Worker 绑定及运行时接缝。
 * @param ctx Cloudflare Cron 执行上下文。
 * @returns 当前不执行任务，因此立即返回。
 */
export const runScheduled: ExportedHandlerScheduledHandler<WorkerBindings> = () => {};
