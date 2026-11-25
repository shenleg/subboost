// 用临时 Git 仓库验证同步计划的路径边界、合并行为与两亲提交。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { git, planSync } from './plan.mjs';

const corePath = 'packages/core/src/converter.ts';

/**
 * 在测试上下文 t 的独立临时目录建立带共同祖先的仓库。base 与 upstream 是两侧要写入的文件。
 * 返回 Git 工作目录、两端 SHA 及 Git 调用器；创建目录或提交失败时抛错。
 */
function fixture(t, { base = {}, upstream = {}, rename } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'subboost-sync-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  /** 执行给定 Git 参数，返回去除尾部空白的标准输出；Git 失败时抛错。 */
  const run = (...args) => git(args, { cwd }).stdout.trimEnd();

  /** 写入路径到内容的映射，无返回值；本地文件写入失败时抛错。 */
  function write(files) {
    for (const [path, content] of Object.entries(files)) {
      const file = join(cwd, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }

  run('init', '-q', '-b', 'original');
  run('config', 'user.name', 'fixture');
  run('config', 'user.email', 'fixture@example.invalid');
  write({ [corePath]: 'original\n', 'README.md': 'original readme\n' });
  run('add', '.');
  run('commit', '-qm', 'ancestor');
  const ancestor = run('rev-parse', 'HEAD');
  run('switch', '-qc', 'fork');
  write({ 'worker/index.ts': 'keep worker\n', ...base });
  run('add', '.');
  run('commit', '-qm', 'fork changes');
  const fork = run('rev-parse', 'HEAD');
  run('switch', '-qc', 'upstream', ancestor);
  write(upstream);
  if (rename) {
    mkdirSync(dirname(join(cwd, rename[1])), { recursive: true });
    run('mv', ...rename);
  }
  run('add', '.');
  run('commit', '-q', '--allow-empty', '-m', 'upstream changes');
  return { cwd, base: fork, ancestor, upstream: run('rev-parse', 'HEAD'), run };
}

test('reports no update for an upstream commit in Fork history', t => {
  const { cwd, base, ancestor } = fixture(t);
  assert.deepEqual(planSync(base, ancestor, { cwd }), { state: 'current', base, upstream: ancestor });
});

test('reproduces a two-parent merge without affecting the checkout or Worker files', t => {
  const { cwd, base, upstream, run } = fixture(t, { upstream: { [corePath]: 'fixed\n' } });
  const before = run('rev-parse', 'HEAD');
  const plan = planSync(base, upstream, { cwd });
  assert.equal(plan.state, 'candidate');
  assert.equal(plan.candidate, planSync(base, upstream, { cwd }).candidate);
  assert.equal(run('show', '-s', '--format=%P', plan.candidate), `${base} ${upstream}`);
  assert.equal(run('show', `${plan.candidate}:${corePath}`), 'fixed');
  assert.equal(run('show', `${plan.candidate}:worker/index.ts`), 'keep worker');
  assert.equal(run('rev-parse', 'HEAD'), before);
  assert.equal(run('status', '--porcelain'), '');
  assert.equal(planSync(plan.candidate, upstream, { cwd }).state, 'current');
});

test('keeps CI, schema, new API and shared manifests out of automatic merge', t => {
  const paths = [
    '.github/workflows/check.yml', 'local/prisma/schema.prisma', 'local/app/api/new/route.ts',
    'package.json', 'worker/new.ts', 'packages/core/src/.gitattributes',
  ];
  const { cwd, base, upstream } = fixture(t, { upstream: Object.fromEntries(paths.map(path => [path, 'changed\n'])) });
  const plan = planSync(base, upstream, { cwd });
  assert.equal(plan.state, 'blocked');
  assert.deepEqual(plan.review.map(item => item.path).sort(), paths.sort());
  assert.equal(Object.hasOwn(plan, 'candidate'), false);
});

test('checks the destination of a rename even if the source was safe', t => {
  const path = 'local/app/api/imported/route.ts';
  const { cwd, base, upstream } = fixture(t, { rename: [corePath, path] });
  const plan = planSync(base, upstream, { cwd });
  assert.equal(plan.state, 'blocked');
  assert.deepEqual(plan.review.map(({ status, path }) => [status, path]), [['R', path]]);
  assert.equal(plan.paths.length, 2);
});

test('checks the source of a rename even if the destination is safe', t => {
  const path = 'local/app/api/imported/route.ts';
  const { cwd, upstream, run } = fixture(t, { rename: [corePath, path] });
  // 把契约路径移回共享代码，确认源路径仍交给人工。
  mkdirSync(join(cwd, dirname(corePath)), { recursive: true });
  run('mv', path, corePath);
  run('commit', '-qm', 'renamed out of local API');
  const reversed = planSync(upstream, run('rev-parse', 'HEAD'), { cwd });
  assert.equal(reversed.state, 'blocked');
  assert.deepEqual(reversed.review.map(item => item.path), [path]);
});

test('reports a real merge conflict without mutating the worktree', t => {
  const { cwd, base, upstream, run } = fixture(t, {
    base: { [corePath]: 'fork change\n' }, upstream: { [corePath]: 'upstream change\n' },
  });
  const plan = planSync(base, upstream, { cwd });
  assert.equal(plan.state, 'blocked');
  assert.match(plan.reason, /冲突/);
  assert.deepEqual(plan.review.map(item => item.path), [corePath]);
  assert.equal(run('rev-parse', 'HEAD'), upstream);
  assert.equal(run('status', '--porcelain'), '');
});
