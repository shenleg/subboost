// 通过 Worker HTTP 入口验证管理订阅与公开分发的契约。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

/** 创建真实管理员会话；返回请求头，初始化失败时断言报错。 */
async function adminHeaders(request: Awaited<ReturnType<typeof createWorkerFixture>>["request"]) {
  const response = await request("/api/setup/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "subscription-test-password", passwordConfirm: "subscription-test-password" }),
  });
  expect(response.status).toBe(200);
  return { Cookie: response.headers.get("Set-Cookie")!.split(";")[0], "Content-Type": "application/json" };
}

it("要求管理员会话，且严格校验并持久化订阅源设置", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "subscription-test" } });
  const path = "/api/settings/source-import";
  expect(await (await fixture.request(path)).json()).toMatchObject({ code: "UNAUTHORIZED" });
  const headers = await adminHeaders(fixture.request);
  expect(await (await fixture.request(path, { headers })).json()).toEqual({ allowUnsafeSubscriptionSources: false });
  const invalid = await fixture.request(path, { method: "PATCH", headers, body: '{"allowUnsafeSubscriptionSources":"true"}' });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  const saved = await fixture.request(path, { method: "PATCH", headers, body: '{"allowUnsafeSubscriptionSources":true}' });
  expect(saved.status).toBe(200);
  expect(await (await fixture.request(path, { headers })).json()).toEqual({ allowUnsafeSubscriptionSources: true });
});

it("导入远程节点及流量头，开启设置仍不允许重定向到私网", async () => {
  const source = "https://source.example/nodes";
  const calls: string[] = [];
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test",
    fetch: async (input) => {
      calls.push(String(input));
      if (String(input) === source) return new Response("ss://YWVzLTEyOC1nY206cGFzcw@edge.example:443#Example", {
        headers: { "subscription-userinfo": "upload=1; download=2; total=10" },
      });
      return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/nodes" } });
    },
  } });
  const headers = await adminHeaders(fixture.request);
  const imported = await fixture.request("/api/source-import", { method: "POST", headers, body: JSON.stringify({ url: source }) });
  expect(imported.status).toBe(200);
  expect(await imported.json()).toMatchObject({
    headers: { "subscription-userinfo": "upload=1; download=2; total=10" },
    parseResult: { nodes: [expect.objectContaining({ name: "Example" })] },
  });
  await fixture.request("/api/settings/source-import", { method: "PATCH", headers, body: '{"allowUnsafeSubscriptionSources":true}' });
  const blocked = await fixture.request("/api/source-import", {
    method: "POST", headers, body: '{"url":"https://source.example/redirect"}',
  });
  expect(blocked.status).toBe(400);
  expect(await blocked.json()).toMatchObject({ errorInfo: { category: "security" } });
  expect(calls).not.toContain("http://127.0.0.1/nodes");
});

const root = "/api/subscriptions";
const node = { name: "Saved node", type: "ss", server: "saved.example", port: 443, cipher: "aes-128-gcm", password: "password" };

/** 通过 HTTP 保存订阅；返回摘要，创建失败时断言报错。 */
async function createSubscription(request: Awaited<ReturnType<typeof createWorkerFixture>>["request"], headers: HeadersInit, body = {}) {
  const response = await request(root, { method: "POST", headers, body: JSON.stringify({ name: "Example", nodes: [node], ...body }) });
  expect(response.status).toBe(201);
  const { subscription } = await response.json() as { subscription: { id: string; token: string; subscriptionUrl: string } };
  return subscription;
}

it("订阅 CRUD 返回当前站点链接、保留未提交字段并替换配置", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "subscription-test" } });
  expect((await fixture.request(root)).status).toBe(401);
  const headers = await adminHeaders(fixture.request);
  const { id, token } = await createSubscription(fixture.request, headers, { config: { rules: ["MATCH,DIRECT"] }, autoUpdateInterval: 360 });
  const path = `${root}/${id}`;
  const detail = await fixture.request(`https://custom.example${path}`, { headers: { ...headers, Origin: "https://wrong.example" } });
  expect(await detail.json()).toMatchObject({ subscription: {
    token, nodeCount: 1, nodes: [node], autoUpdateInterval: 360, subscriptionUrl: `https://custom.example${root}/${token}/config.yaml`,
  } });
  const updated = await fixture.request(path, { method: "PUT", headers, body: '{"name":"Renamed","config":{}}' });
  expect(updated.status).toBe(200);
  const reread = await (await fixture.request(path, { headers })).json();
  expect(reread).toMatchObject({ subscription: { name: "Renamed", nodes: [node], config: { smartNodeMatchingEnabled: true } } });
  expect(reread).not.toHaveProperty("subscription.config.rules");
  expect(await (await fixture.request(root, { headers })).json()).toMatchObject({ subscriptions: [{ id, name: "Renamed", nodeCount: 1 }] });
  expect(await (await fixture.request(path, { method: "DELETE", headers })).json()).toEqual({ success: true });
  expect((await fixture.request(path, { headers })).status).toBe(404);
});

it("用公开令牌免登录下载 YAML 和 Clash 流量头，删除即失效", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "subscription-test" } });
  const headers = await adminHeaders(fixture.request);
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, {
    name: "套餐测试", autoUpdateInterval: 3600,
    subscriptionInfo: { upload: 1, download: 2, total: 10, profileWebPageUrl: "https://provider.example/", planName: "Basic" },
  });
  const yaml = await fixture.request(subscriptionUrl);
  expect(yaml.status).toBe(200);
  expect(yaml.headers.get("Content-Type")).toBe("text/yaml;charset=utf-8");
  expect(yaml.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E5%A5%97%E9%A4%90%E6%B5%8B%E8%AF%95");
  expect(yaml.headers.get("Cache-Control")).toBe("no-store");
  expect(yaml.headers.get("Profile-Update-Interval")).toBe("1");
  expect(yaml.headers.get("Subscription-Userinfo")).toBe("upload=1; download=2; total=10");
  expect(yaml.headers.get("Profile-Web-Page-Url")).toBe("https://provider.example/");
  expect(yaml.headers.get("Plan-Name")).toBe("Basic");
  expect(await yaml.text()).toContain("saved.example");
  expect(await (await fixture.request(`${root}/${id}`, { headers })).json()).toMatchObject({ subscription: { lastAccessedAt: null } });
  await fixture.request(`${root}/${id}`, { method: "DELETE", headers });
  expect((await fixture.request(subscriptionUrl)).status).toBe(404);
});

it("同一 If-Match 并发轮换只成功一次，旧公开令牌立即失效", async () => {
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "subscription-test" } });
  const headers = await adminHeaders(fixture.request);
  const { id, token, subscriptionUrl } = await createSubscription(fixture.request, headers);
  const path = `${root}/${id}/reset-link`;
  const bad = await fixture.request(path, { method: "POST", headers: { ...headers, "If-Match": token } });
  expect(bad.status).toBe(400);
  const reset = () => fixture.request(path, { method: "POST", headers: { ...headers, "If-Match": `"${token}"` } });
  const [first, second] = await Promise.all([reset(), reset()]);
  const [ok, conflict] = [first, second].sort((a, b) => a.status - b.status);
  expect([ok.status, conflict.status]).toEqual([200, 409]);
  expect(ok.headers.get("Cache-Control")).toBe("no-store");
  expect(await conflict.json()).toMatchObject({ code: "CONFLICT" });
  const rotated = await ok.json() as { subscription: { token: string; subscriptionUrl: string } };
  expect(rotated.subscription.token).not.toBe(token);
  expect((await fixture.request(subscriptionUrl)).status).toBe(404);
  expect((await fixture.request(rotated.subscription.subscriptionUrl)).status).toBe(200);
});

it("手动刷新发布新节点与流量数据，来源全失败时保留缓存", async () => {
  let failing = false;
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test",
    fetch: async () => failing ? new Response(null, { status: 502 }) :
      new Response("ss://YWVzLTEyOC1nY206cGFzcw@fresh.example:443#Fresh", {
        headers: { "subscription-userinfo": "upload=10240; download=20480; total=1048576" },
      }),
  } });
  const headers = await adminHeaders(fixture.request);
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, { urls: ["https://source.example/nodes"], nodes: [] });
  expect((await fixture.request(subscriptionUrl)).status).toBe(404);
  const path = `${root}/${id}/refresh`;
  const refresh = await fixture.request(path, { method: "POST", headers });
  expect(refresh.status).toBe(200);
  expect(await refresh.json()).toMatchObject({ success: true, subscriptionId: id, nodeCount: 1, refreshedSourceCount: 1 });
  failing = true;
  const failure = await fixture.request(path, { method: "POST", headers });
  expect(failure.status).toBe(502);
  expect(await failure.json()).toMatchObject({ code: "EXTERNAL_FETCH_FAILED" });
  const yaml = await fixture.request(subscriptionUrl);
  expect(yaml.headers.get("Subscription-Userinfo")).toBe("upload=10240; download=20480; total=1048576");
  expect(await yaml.text()).toContain("fresh.example");
});

it("部分来源失败时仍刷新成功来源，并保留失败来源的已有节点", async () => {
  let resync = false;
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test",
    fetch: async (input) => {
      const sourceA = new URL(String(input)).pathname === "/a";
      if (resync && !sourceA) return new Response(null, { status: 502 });
      const endpoint = sourceA ? (resync ? "new-a.example" : "old-a.example") : "old-b.example";
      return new Response(`ss://YWVzLTEyOC1nY206cGFzcw@${endpoint}:443#${sourceA ? "A" : "B"}`);
    },
  } });
  const headers = await adminHeaders(fixture.request);
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, {
    urls: ["https://source.example/a", "https://source.example/b"], nodes: [],
  });
  const refresh = () => fixture.request(`${root}/${id}/refresh`, { method: "POST", headers });
  expect((await refresh()).status).toBe(200);
  resync = true;
  const result = await refresh();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ refreshedSourceCount: 1, failedSourceCount: 1, nodeCount: 2 });
  const yaml = await (await fixture.request(subscriptionUrl)).text();
  expect(yaml).toContain("new-a.example");
  expect(yaml).toContain("old-b.example");
  expect(yaml).not.toContain("old-a.example");
});

it("刷新等待来源期间编辑同毫秒的快照，旧刷新不覆盖订阅或更新状态", async () => {
  const entered = Promise.withResolvers<void>();
  const allowed = Promise.withResolvers<void>();
  const now = Date.now();
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test", now: () => now,
    fetch: async () => {
      entered.resolve();
      await allowed.promise;
      return new Response("ss://YWVzLTEyOC1nY206cGFzcw@stale.example:443#Stale");
    },
  } });
  const headers = await adminHeaders(fixture.request);
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, { urls: ["https://source.example/nodes"] });
  const path = `${root}/${id}`;
  // 预置只有未来 Cron 能产生的失败状态；通过 HTTP 观察 CAS 零行不应清除它。
  await fixture.db.prepare(`INSERT INTO SubscriptionAutoUpdateState (subscriptionId, externalFailureCount, createdAt, updatedAt)
    VALUES (?, 2, ?, ?)`).bind(id, now, now).run();
  const refreshing = fixture.request(`${path}/refresh`, { method: "POST", headers });
  try {
    await entered.promise;
    const edit = await fixture.request(path, { method: "PUT", headers, body: '{"name":"Edited"}' });
    expect(edit.status).toBe(200);
  } finally {
    allowed.resolve();
  }
  const stale = await refreshing;
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "SUBSCRIPTION_CHANGED" });
  expect(await (await fixture.request(path, { headers })).json()).toMatchObject({ subscription: {
    name: "Edited", lastUpdatedAt: null, autoUpdateState: { externalFailureCount: 2 },
  } });
  const yaml = await (await fixture.request(subscriptionUrl)).text();
  expect(yaml).toContain("saved.example");
  expect(yaml).not.toContain("stale.example");
  const enabled = await fixture.request(path, { method: "PUT", headers, body: '{"autoUpdateInterval":360}' });
  expect(enabled.status).toBe(200);
  expect(await (await fixture.request(path, { headers })).json()).toMatchObject({ subscription: {
    autoUpdateInterval: 360, autoUpdateState: { externalFailureCount: 0 },
  } });
});

it("加密快照超出 D1 整行上限时不覆盖缓存或失败计数", async () => {
  const now = Date.now();
  // 八个合法节点远低于节点配额，只有加密及整行叠加后超过 D1 限制。
  const proxies = Array.from({ length: 8 }, (_, i) => ({ ...node, name: `Large${i}`, port: 443 + i, password: "x".repeat(95_000) }));
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test", now: () => now,
    fetch: async () => new Response(JSON.stringify({ proxies })),
  } });
  const headers = await adminHeaders(fixture.request);
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, {
    urls: ["https://source.example/nodes"], config: { notes: "x".repeat(260_000) },
  });
  const path = `${root}/${id}`;
  // 限额异常既不是节点配额失败，也不是对既有来源失败状态的成功清零。
  await fixture.db.prepare(`INSERT INTO SubscriptionAutoUpdateState (subscriptionId, externalFailureCount, createdAt, updatedAt)
    VALUES (?, 2, ?, ?)`).bind(id, now, now).run();
  const refresh = await fixture.request(`${path}/refresh`, { method: "POST", headers });
  expect(refresh.status).toBe(413);
  expect(await refresh.json()).toMatchObject({ code: "SUBSCRIPTION_STORAGE_LIMIT" });
  const edit = await fixture.request(path, { method: "PUT", headers, body: JSON.stringify({ config: { notes: "汉".repeat(350_000) } }) });
  expect(edit.status).toBe(413);
  expect(await edit.json()).toMatchObject({ code: "SUBSCRIPTION_STORAGE_LIMIT" });
  expect(await (await fixture.request(path, { headers })).json()).toMatchObject({ subscription: {
    nodes: [node], lastUpdatedAt: null, autoUpdateState: { externalFailureCount: 2, nodeQuotaFailureCount: 0 },
  } });
  expect(await (await fixture.request(subscriptionUrl)).text()).toContain("saved.example");
});

it("耗尽实际出站子请求预算时不发布部分刷新结果", async () => {
  let calls = 0;
  await using fixture = await createWorkerFixture({ bindings: {
    ENCRYPTION_KEY: "subscription-test",
    fetch: async (input) => {
      calls++;
      const url = new URL(String(input));
      if (url.pathname === "/good") return new Response("ss://YWVzLTEyOC1nY206cGFzcw@partial.example:443#Partial");
      const hop = Number(url.searchParams.get("hop") ?? 0);
      return hop < 3 ? new Response(null, { status: 302, headers: { Location: `?hop=${hop + 1}` } }) :
        new Response(null, { status: 502 });
    },
  } });
  const headers = await adminHeaders(fixture.request);
  const urls = ["https://source.example/good", ...Array.from({ length: 14 }, (_, i) => `https://source.example/${i}`)];
  const { id, subscriptionUrl } = await createSubscription(fixture.request, headers, { urls });
  const response = await fixture.request(`${root}/${id}/refresh`, { method: "POST", headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "EXTERNAL_FETCH_BUDGET_EXCEEDED" });
  expect(calls).toBe(48);
  const yaml = await (await fixture.request(subscriptionUrl)).text();
  expect(yaml).toContain("saved.example");
  expect(yaml).not.toContain("partial.example");
});

it("公开下载按令牌限流并在窗口结束后恢复", async () => {
  let now = Date.now();
  await using fixture = await createWorkerFixture({ bindings: { ENCRYPTION_KEY: "subscription-test", now: () => now } });
  const headers = await adminHeaders(fixture.request);
  const { subscriptionUrl } = await createSubscription(fixture.request, headers);
  const firstIp = { "CF-Connecting-IP": "192.0.2.11" };
  for (let i = 0; i < 120; i++) expect((await fixture.request(subscriptionUrl, { headers: firstIp })).status).toBe(200);
  const secondIp = { "CF-Connecting-IP": "192.0.2.12" };
  const limited = await fixture.request(subscriptionUrl, { headers: secondIp });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  now += 60_000;
  expect((await fixture.request(subscriptionUrl, { headers: secondIp })).status).toBe(200);
});
