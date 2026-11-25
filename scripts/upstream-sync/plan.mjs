// 读取上游增量，按 Worker 同步边界生成可复验的候选提交或人工审查报告。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const zones = JSON.parse(readFileSync(new URL('../../docs/upstream-sync-zones.json', import.meta.url), 'utf8'));
const parity = JSON.parse(readFileSync(new URL('../../docs/worker-parity.json', import.meta.url), 'utf8'));
const sampleLimit = 20; // PR/Issue 只展示少量路径，完整 diff 通过提交链接查看。

/**
 * 执行 Git，禁用 hooks。参数是独立的命令参数，选项可指定工作目录、允许的非零退出码和额外环境变量。
 * 返回命令退出状态和原始输出；Git 启动失败或返回未预期的状态时抛错。
 */
export function git(args, { cwd, allow = [], env = {} } = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allow.includes(result.status)) {
    throw new Error(`Git ${args[0]} 失败（${result.status ?? result.signal}）：${result.stderr.trim()}`);
  }
  return result;
}

function changedPaths(cwd, from, to) {
  const fields = git(['diff', '--name-status', '-z', '--find-renames', from, to, '--'], { cwd }).stdout.split('\0');
  fields.pop();
  const paths = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++][0];
    paths.push({ status, path: fields[i++] });
    if (status === 'R' || status === 'C') paths.push({ status, path: fields[i++] });
  }
  return paths;
}

function zoneFor(path) {
  return zones.rules.find(rule => rule.exact?.includes(path) || rule.prefix?.some(prefix => path.startsWith(prefix)))?.zone
    ?? zones.defaultZone;
}

function reviewReason({ status, path }) {
  if (path === '.github' || path.startsWith('.github/')) return 'CI 或仓库自动化配置';
  if (path === '.gitattributes' || path.endsWith('/.gitattributes')) return 'Git 合并属性变更';
  const zone = zoneFor(path);
  if (zone === 'worker-owned') return '上游触及 Worker 专属区';
  if (zone === 'shared') {
    if (status === 'M' && ['README.md', 'README-CN.md'].includes(path)) return null;
    return '共享配置或未分类路径';
  }
  if (path.startsWith('local/app/api/') && /\/route\.[^/]+$/.test(path)) return '核对 Worker HTTP/Cron 契约';
  if (path.startsWith('local/prisma/') || path === parity.database.localSchema) return '核对 D1 数据结构和迁移';
  if (parity.pages.some(page => page.local === path) || /\/(?:page|layout)\.tsx?$/.test(path)) return '核对 Worker 页面与兼容层';
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return null;
  // 仅把已知低冲突路径交给无人值守试合并；通过路径筛选不代表行为已经兼容。
  if (path.startsWith('packages/core/src/') && !path.endsWith('/index.ts')) return null;
  if (path.startsWith('local/test/') || path.startsWith('local/public/') || path.startsWith('packages/ui/assets/')) return null;
  if (path.startsWith('local/') || path.startsWith('packages/')) return '核对 API、依赖或运行时兼容性';
  if (path === 'LICENSE') return '核对许可变更';
  return null;
}

/**
 * 检查本仓库基线和已 fetch 的上游提交；cwd 指向包含这两者的 Git 仓库。
 * 返回 current、blocked 或 candidate 报告。只写 Git 对象，不改工作树、索引或分支；预期外的 Git 错误直接抛出。
 */
export function planSync(baseRef, upstreamRef, { cwd } = {}) {
  const base = git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], { cwd }).stdout.trim();
  const upstream = git(['rev-parse', '--verify', '--end-of-options', `${upstreamRef}^{commit}`], { cwd }).stdout.trim();
  if (git(['merge-base', '--is-ancestor', upstream, base], { cwd, allow: [1] }).status === 0) {
    return { state: 'current', base, upstream };
  }

  const common = git(['merge-base', '--all', base, upstream], { cwd, allow: [1] }).stdout.trim().split(/\s+/).filter(Boolean);
  if (common.length !== 1) {
    return { state: 'blocked', base, upstream, reason: '找不到唯一的共同祖先，需要人工检查上游历史。' };
  }
  const [ancestor] = common;
  const changes = changedPaths(cwd, ancestor, upstream);
  const review = changes.flatMap(change => {
    const reason = reviewReason(change);
    return reason ? [{ ...change, reason }] : [];
  });
  const report = { base, upstream, ancestor, pathCount: changes.length, paths: changes.slice(0, sampleLimit) };
  if (review.length) {
    return {
      state: 'blocked', ...report, reason: '上游改动超出 bot 可直接同步的范围。',
      review: review.slice(0, sampleLimit), reviewCount: review.length,
    };
  }
  const merged = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, upstream], { cwd, allow: [1] });
  const [tree, ...conflicts] = merged.stdout.split('\0').filter(Boolean);
  if (merged.status === 1) {
    const unique = [...new Set(conflicts)];
    return {
      state: 'blocked', ...report, reason: '试合并发现 Git 冲突。', reviewCount: unique.length,
      review: unique.slice(0, sampleLimit).map(path => ({ status: '冲突', path, reason: '逐文件裁决，不全局选 ours/theirs' })),
    };
  }

  // Git 的目录重命名推断可能把安全路径移到别处；发布前也要核对候选树相对于 Fork 的实际改动。
  const mergedReview = changedPaths(cwd, base, tree).flatMap(change => {
    const reason = reviewReason(change);
    return reason ? [{ ...change, reason }] : [];
  });
  if (mergedReview.length) {
    return {
      state: 'blocked', ...report, reason: '候选合并触及本仓库受保护的路径。',
      review: mergedReview.slice(0, sampleLimit), reviewCount: mergedReview.length,
    };
  }

  // 三个隔离的 job 必须能独立复现同一个 SHA；禁止用运行时间或 runner 身份生成提交。
  const dates = [base, upstream].map(sha => Number(git(['show', '-s', '--format=%ct', sha], { cwd }).stdout));
  const identity = {
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_AUTHOR_DATE: `${Math.max(...dates)} +0000`, GIT_COMMITTER_DATE: `${Math.max(...dates)} +0000`,
  };
  const candidate = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', base, '-p', upstream,
    '-m', `同步上游 SubBoost（${upstream.slice(0, 12)}）`], { cwd, env: identity }).stdout.trim();
  return { state: 'candidate', ...report, candidate };
}

if (import.meta.main) {
  const [base, upstream] = process.argv.slice(2);
  if (!base || !upstream) throw new Error('用法：node scripts/upstream-sync/plan.mjs <基线 ref> <上游 ref>');
  process.stdout.write(`${JSON.stringify(planSync(base, upstream))}\n`);
}
