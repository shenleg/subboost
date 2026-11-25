// 用受限 GitHub 令牌发布同步报告；本文件始终从受信任的本仓库基线执行。
import { spawnSync } from 'node:child_process';
import { git, planSync } from './plan.mjs';

const branchPrefix = 'automation/upstream-sync/';
const issueMarker = '<!-- upstream-sync-bot:blocked -->';
const botLogin = 'github-actions[bot]';
const upstreamRepo = 'https://github.com/SubBoost/subboost';

function api(endpoint, { method = 'GET', body } = {}) {
  const result = spawnSync('gh', ['api', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])], {
    input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GitHub API 请求失败：${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function findInPages(request, query, match) {
  const pageSize = 100; // 使用 API 最大页大小，避免有大量历史 PR/Issue 时漏掉待处理项。
  for (let page = 1; ; page++) {
    const items = request(`${query}&per_page=${pageSize}&page=${page}`);
    const found = items.find(match);
    if (found || items.length < pageSize) return found;
  }
}

function currentMain() {
  return git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).stdout.split(/\s+/)[0];
}

function verifyCandidate(plan) {
  git(['fetch', '--no-tags', `${upstreamRepo}.git`, plan.upstream]);
  return planSync(plan.base, plan.upstream).candidate;
}

function pushCandidate(candidate, branch) {
  git(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin',
    `${candidate}:refs/heads/${branch}`]);
}

/**
 * 查找同一个仓库内尚未关闭的同步 PR；request 可替换为测试用 API。
 * 返回匹配的 PR 或 undefined；API 请求失败时抛错。
 */
export function openSyncPr(repo, request = api) {
  return findInPages(request, `repos/${repo}/pulls?state=open&base=main`,
    pr => pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase() && pr.head.ref.startsWith(branchPrefix));
}

function inlineCode(text) {
  // 路径由上游控制；保留可读的文件名，但禁止换行、反引号或 @ 进入 GitHub 的 Markdown 语法。
  return `\`${JSON.stringify(text).replace(/[\x60@<>]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\``;
}

function rangeDetails(plan, repo) {
  const { base, upstream, ancestor, pathCount } = plan;
  return [
    `- 本仓库基线：[\`${base.slice(0, 12)}\`](https://github.com/${repo}/commit/${base})`,
    `- 上游提交：[\`${upstream.slice(0, 12)}\`](${upstreamRepo}/commit/${upstream})`,
    ...(ancestor ? [`- [查看完整上游 diff](${upstreamRepo}/compare/${ancestor}...${upstream})（涉及 ${pathCount} 个路径）`] : []),
  ];
}

function changedPathDetails(paths, total) {
  if (!paths?.length) return [];
  return [
    '', '涉及路径：', '',
    ...paths.map(item => `- ${item.status} ${inlineCode(item.path)}${item.reason ? `：${item.reason}` : ''}`),
    ...(total > paths.length ? [`- 另有 ${total - paths.length} 个路径，请查看完整 diff。`] : []),
  ];
}

/**
 * 根据可信计划与门禁结果创建同步 PR，或幂等地创建/更新一条人工接手 Issue。
 * 可注入 Git 和 API 操作用于测试。返回运行摘要；过期计划无写入，发布或校验出错时抛错。
 */
export function publishSync({ repo, plan, gate, runUrl }, operations = {}) {
  const { request = api, getMain = currentMain, reproduce = verifyCandidate, push = pushCandidate } = operations;
  if (!['blocked', 'candidate'].includes(plan.state)) throw new Error('只发布已分类的同步报告。');
  if (getMain() !== plan.base) return 'Fork main 已更新，跳过旧计划；下次运行重新计算。';

  if (plan.state === 'blocked') {
    const title = '上游同步需要人工接手';
    const body = [
      issueMarker, '', plan.reason, '', ...rangeDetails(plan, repo),
      ...changedPathDetails(plan.review ?? plan.paths, plan.reviewCount ?? plan.pathCount), '',
      `请按[同步手册](https://github.com/${repo}/blob/${plan.base}/docs/upstream-sync-guide.md)从本仓库 main 新建分支，`,
      '合并上述上游 SHA，补齐 Worker 适配及契约测试后，执行 `npm run check:worker` 并提 PR。',
    ].join('\n');
    const existing = findInPages(request, `repos/${repo}/issues?state=open`,
      issue => !issue.pull_request && issue.user?.login === botLogin && issue.body?.startsWith(issueMarker));
    if (existing?.title === title && existing.body === body) return `已有相同的接手报告：${existing.html_url}`;
    const issue = existing
      ? request(`repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: { title, body } })
      : request(`repos/${repo}/issues`, { method: 'POST', body: { title, body } });
    return `人工接手 Issue：${issue.html_url}`;
  }

  if (!['success', 'failure'].includes(gate)) throw new Error(`候选提交没有可发布的门禁结论：${gate}`);
  const existing = openSyncPr(repo, request);
  if (existing) return `已有同步 PR，保留其分支和人工改动：${existing.html_url}`;
  if (reproduce(plan) !== plan.candidate) throw new Error('重算的候选提交与门禁输入不一致，不发布。');

  // 分支绑定基线与上游。重跑可复用同一提交，但不会强推覆盖维护者追加的提交。
  const branch = `${branchPrefix}${plan.base.slice(0, 12)}-${plan.upstream.slice(0, 12)}`;
  const passed = gate === 'success';
  const body = [
    ...rangeDetails(plan, repo),
    `- \`check:worker\`：${passed ? '通过' : '未通过（草稿，待修复）'}；[Actions 运行日志](${runUrl})。`,
    ...changedPathDetails(plan.paths, plan.pathCount), '',
    '审查后请使用 **Create a merge commit**，保留上游提交历史。不自动合入或部署。',
  ].join('\n');
  if (getMain() !== plan.base) return 'Fork main 在候选复验期间更新，跳过旧计划。';
  push(plan.candidate, branch);
  const pr = request(`repos/${repo}/pulls`, {
    method: 'POST', body: {
      title: `同步上游 SubBoost（${plan.upstream.slice(0, 12)}）`, base: 'main', head: branch, body, draft: !passed,
    },
  });
  return `${passed ? '同步 PR' : '门禁失败的草稿 PR'}：${pr.html_url}`;
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('需要设置 GITHUB_REPOSITORY。');
  if (process.argv[2] === 'pending') {
    const pending = openSyncPr(repo);
    process.stdout.write(`${pending?.html_url ?? ''}\n`);
  } else {
    const { SYNC_PLAN, GATE_RESULT, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
    const runUrl = `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}`;
    process.stdout.write(`${publishSync({ repo, plan: JSON.parse(SYNC_PLAN), gate: GATE_RESULT, runUrl })}\n`);
  }
}
