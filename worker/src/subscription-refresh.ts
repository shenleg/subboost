// 将 Worker 出站传输接到共享订阅刷新核心，供手动和后续 Cron 装配。
import {
  prepareRefreshCacheResult, refreshNodeSnapshot, SUBSCRIPTION_IMPORT_USER_AGENTS,
  type RefreshNodeSnapshotOptions,
} from "@subboost/server-core/subscription";
import type { SubscriptionSecrets } from "./subscription-store";
import type { createExternalTransport } from "./transport";

/** 原版单订阅的节点数量上限；与 Worker 独立的 D1 字节上限分别判断。 */
export const MAX_NODES_PER_SUBSCRIPTION = 10_000;
// 上游补充流量请求限制；只读取 HEAD，不下载订阅正文。
const USERINFO_TIMEOUT_MS = 8_000;
const USERINFO_MAX_BYTES = 256 * 1024;

/** 可分别装饰或重放的订阅正文和补充流量回调。 */
export type SubscriptionFetchCallbacks = Pick<RefreshNodeSnapshotOptions, "fetchUrlNodes" | "fetchUrlUserInfo">;

/**
 * 用一个调用共享的出站预算构造两种刷新回调，便于 Cron 按回调用途安排和重放。
 * @param transport 本次调用的 Worker 安全传输。
 * @returns 已接入共享导入器的正文回调，以及只读取 HEAD 的流量回调。
 * @throws 回调遇到子请求预算拒绝时传播 ExternalFetchBudgetExceededError；不伪装为订阅源失败。
 */
export function buildSubscriptionFetchCallbacks(transport: ReturnType<typeof createExternalTransport>): Required<SubscriptionFetchCallbacks> {
  return {
    async fetchUrlNodes(source) {
      const imported = await transport.importSubscription({
        url: source.content, userinfoUrl: source.userinfoUrl, userinfoUserAgent: source.userinfoUserAgent,
      });
      if (imported.ok) return { ok: true, nodes: imported.parsedNodes, errors: imported.parseErrors, headers: imported.headers };
      return { ok: false, nodes: [], responseStatus: imported.responseStatus, error: imported.error,
        errorInfo: imported.errorInfo, publicReason: imported.publicReason };
    },
    async fetchUrlUserInfo(source) {
      if (!source.userinfoUrl) return undefined;
      transport.budget.throwIfDenied();
      const result = await transport.fetchText({ url: source.userinfoUrl,
        userAgent: source.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
        purpose: "userinfo", timeoutMs: USERINFO_TIMEOUT_MS, maxBytes: USERINFO_MAX_BYTES });
      return result.ok ? result.headers : undefined;
    },
  };
}

/**
 * 根据冻结快照准备刷新，由调用方决定如何完成和 CAS 提交；本函数不访问 D1。
 * @param secrets 与读取版本配对的解密快照。
 * @param callbacks 可由调度器装饰、缓存或重放的网络回调。
 * @returns 共享快照和缓存准备结果，保留部分来源失败与节点超限信号。
 * @throws 回调抛出的预算拒绝等异常原样传播，不会形成部分刷新结果。
 */
export async function prepareSubscriptionRefresh(secrets: SubscriptionSecrets, callbacks: SubscriptionFetchCallbacks) {
  const snapshot = await refreshNodeSnapshot({ config: secrets.config, urls: secrets.urls, storedNodes: secrets.nodes, ...callbacks });
  const refreshResult = prepareRefreshCacheResult({ config: secrets.config, snapshot, maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION });
  return { snapshot, refreshResult };
}
