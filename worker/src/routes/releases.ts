// 组装上游发布检查端点，版本来自构建输入而不是运行期文件系统。
import { Hono } from "hono";
import type { WorkerApp } from "../env";

/** Worker 发布版本；Wrangler 将根包元数据中的版本静态打入使用它的产物。 */
export { version as WORKER_VERSION } from "../../../package.json";

/** 挂在 `/api` 下的 `/releases/latest` 路由。 */
export const releaseRoutes = new Hono<WorkerApp>();
