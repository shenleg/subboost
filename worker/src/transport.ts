// 提供 Worker 对外 HTTP 的底层 fetch 接缝；协议校验和预算应由调用方的传输层管理。
import type { WorkerBindings } from "./env";

/**
 * 选择当前调用的外部 fetch，供后续的受限传输适配器使用；本函数不发送请求。
 * @param env Worker 绑定，可注入测试传输。
 * @returns 测试传输，或绑定到 Worker 全局对象的标准 fetch。
 */
export function getExternalFetch(env: WorkerBindings): typeof globalThis.fetch {
  return env.fetch ?? globalThis.fetch.bind(globalThis);
}
