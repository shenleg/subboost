// 验证 bot 的 PR/Issue 决策和重复运行行为，不向 GitHub 写入测试数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSyncPr, publishSync } from './publish.mjs';

const repo = 'shenleg/subboost';
const base = 'a'.repeat(40);
const upstream = 'b'.repeat(40);
const candidate = 'c'.repeat(40);
const ancestor = 'd'.repeat(40);
const link = `https://github.com/${repo}/actions/runs/1`;
const candidatePlan = { state: 'candidate', base, upstream, ancestor, pathCount: 1, candidate };
const blocked = {
  state: 'blocked', base, upstream, ancestor, pathCount: 1, reviewCount: 1, reason: '人工检查',
  review: [{ status: 'M', path: 'local/app/api/`@someone\n/route.ts', reason: '核对契约' }],
};

/**
 * 为给定计划准备只在内存内运行的发布操作。options 可改变门禁、远端 main、候选 SHA 与打开的对象。
 * 返回发布调用、写入记录和分支推送记录；桩遇到不支持的写操作时抛错。
 */
function fixture(plan, options = {}) {
  const writes = [];
  const pushes = [];
  const run = () => publishSync({ repo, plan, gate: options.gate ?? 'success', runUrl: link }, {
    getMain: () => options.main ?? base,
    reproduce: () => options.reproduced ?? candidate,
    push: (...args) => pushes.push(args),
    request: (path, data) => {
      if (path.includes('/pulls?')) return options.prs ?? [];
      if (path.includes('/issues?')) return options.issues ?? [];
      if (!data || !['POST', 'PATCH'].includes(data.method)) throw new Error(`意外的 API：${path}`);
      writes.push({ path, ...data });
      return { html_url: `https://github.com/${repo}/issues/1` };
    },
  });
  return { run, writes, pushes };
}

test('pushes the exact verified candidate and creates a reviewable PR only when the gate passes', () => {
  const { run, writes, pushes } = fixture(candidatePlan);
  const branch = `automation/upstream-sync/${base.slice(0, 12)}-${upstream.slice(0, 12)}`;
  assert.match(run(), /同步 PR/);
  assert.deepEqual(pushes, [[candidate, branch]]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `repos/${repo}/pulls`);
  assert.equal(writes[0].body.head, branch);
  assert.equal(writes[0].body.base, 'main');
  assert.equal(writes[0].body.draft, false);
  assert.match(writes[0].body.body, /check:worker`：通过/);
});

test('publishes gate failures only as draft PRs, with a link to the logs and no redundant Issue', () => {
  const { run, writes } = fixture(candidatePlan, { gate: 'failure' });
  assert.match(run(), /草稿 PR/);
  assert.deepEqual(writes.map(({ path, body }) => [path, body.draft]), [[`repos/${repo}/pulls`, true]]);
  assert.ok(writes[0].body.body.includes(link));
});

test('does not publish on stale main, absent validation, or candidate mismatch', () => {
  const stale = fixture(candidatePlan, { main: upstream });
  assert.match(stale.run(), /跳过旧计划/);
  const mismatch = fixture(candidatePlan, { reproduced: base });
  assert.throws(mismatch.run, /不一致/);
  const skipped = fixture(candidatePlan, { gate: 'skipped' });
  assert.throws(skipped.run, /没有可发布的门禁结论/);
  for (const item of [stale, mismatch, skipped]) {
    assert.deepEqual(item.writes, []);
    assert.deepEqual(item.pushes, []);
  }
});

test('keeps an active sync PR and any manual commits on its branch', () => {
  const prs = [{ head: { ref: 'automation/upstream-sync/previous', repo: { full_name: repo } } }];
  const { run, writes, pushes } = fixture(candidatePlan, { prs });
  assert.match(run(), /已有同步 PR/);
  assert.deepEqual(writes, []);
  assert.deepEqual(pushes, []);
});

test('finds an active PR across pages without treating a PR from another fork as ours', () => {
  const head = { ref: 'automation/upstream-sync/existing' };
  const expected = { head: { ...head, repo: { full_name: repo } } };
  const external = { head: { ...head, repo: { full_name: 'someone-else/subboost' } } };
  const seen = [];
  const found = openSyncPr(repo, path => {
    seen.push(path);
    return seen.length === 1 ? Array(100).fill(external) : [expected];
  });
  assert.equal(found, expected);
  assert.match(seen[1], /[&]page=2$/);
});

test('creates, deduplicates and updates the bot Issue without pinging names found in paths', () => {
  const first = fixture(blocked, { gate: 'skipped' });
  assert.match(first.run(), /人工接手 Issue/);
  assert.equal(first.writes[0].path, `repos/${repo}/issues`);
  assert.equal(first.writes[0].method, 'POST');
  const created = first.writes[0].body;
  assert.ok(!created.body.includes('@someone'));
  assert.ok(created.body.includes('\\n/route.ts'));
  assert.deepEqual(first.pushes, []);

  const prior = { number: 9, ...created, user: { login: 'github-actions[bot]' } };
  const again = fixture(blocked, { issues: [prior] });
  assert.match(again.run(), /已有相同/);
  assert.deepEqual(again.writes, []);

  const newer = fixture({ ...blocked, upstream: candidate }, { issues: [prior] });
  newer.run();
  assert.equal(newer.writes[0].path, `repos/${repo}/issues/9`);
  assert.equal(newer.writes[0].method, 'PATCH');
});
