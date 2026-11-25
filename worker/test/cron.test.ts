// 验证 Worker 顶层原生 Cron 入口的基本契约。
import { expect, it } from "vitest";
import { createWorkerFixture } from "./fixture";

/** 未配置的 Cron 不需要访问数据库或外部服务。 */
it("忽略未配置的原生 Cron 表达式", async () => {
  await using fixture = await createWorkerFixture({ migrate: false });

  await expect(fixture.scheduled("* * * * *")).resolves.toBeUndefined();
});
