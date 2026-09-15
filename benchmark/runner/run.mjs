#!/usr/bin/env node
/**
 * Mozi Benchmark Runner（技术方案 §8.3 / M5）。
 *
 * 两种模式：
 *  - smoke（默认，零 API 成本）：setup → 应用参考解 → 断言必须全过。
 *    目的：验证「任务可解 + 断言正确」，让评测集自身在 CI 里保持不腐烂。
 *  - live（真实模型跑分）：setup → 用 @mozi/core 引擎执行 task.md 指令 → 断言。
 *    产出：成功率 / 步数 / token / 审批次数 / 耗时，按模型分列。
 *
 * 用法：
 *   node run.mjs [--mode smoke|live] [--level L1|L2|L3|L4] [--task <id>]
 *               [--out results] [--max-ms 300000]
 *
 * live 模式环境变量：
 *   MOZI_BENCH_BASE_URL / MOZI_BENCH_API_KEY / MOZI_BENCH_MODEL
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TASKS_DIR = join(ROOT, 'tasks');
const WORK_DIR = join(ROOT, '.work');
const LEVELS = ['L1', 'L2', 'L3', 'L4'];

// ---------- CLI ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const MODE = arg('mode', 'smoke') === 'live' ? 'live' : 'smoke';
const LEVEL_FILTER = arg('level', null);
const TASK_FILTER = arg('task', null);
const OUT_DIR = resolve(ROOT, arg('out', 'results'));
const MAX_MS = Number(arg('max-ms', MODE === 'live' ? 300_000 : 60_000));

// ---------- 任务发现 ----------
function discover() {
  const tasks = [];
  for (const level of LEVELS) {
    const dir = join(TASKS_DIR, level);
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir).sort()) {
      const taskDir = join(dir, id);
      if (!statSync(taskDir).isDirectory()) continue;
      if (!existsSync(join(taskDir, 'task.md'))) continue;
      tasks.push({ id, level, dir: taskDir });
    }
  }
  return tasks
    .filter((t) => (LEVEL_FILTER ? t.level === LEVEL_FILTER : true))
    .filter((t) => (TASK_FILTER ? t.id === TASK_FILTER : true));
}

// ---------- 工具 ----------
function runNode(script, cwd, timeoutMs) {
  return spawnSync(process.execPath, [script, cwd], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });
}

function copyDir(src, dest) {
  cpSync(src, dest, { recursive: true, force: true });
}

function freshDir(p) {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

// ---------- live 模式：引擎执行 ----------
async function runEngine(task, workspaceDir) {
  const { createEngine, autoApproveGateway } = await import('@mozi/core');
  const { OpenAICompatibleProvider, ProviderRegistry } = await import('@mozi/providers');

  const baseUrl = process.env.MOZI_BENCH_BASE_URL;
  const apiKey = process.env.MOZI_BENCH_API_KEY;
  const model = process.env.MOZI_BENCH_MODEL || 'deepseek-chat';
  if (!baseUrl || !apiKey) {
    throw new Error('live 模式需要 MOZI_BENCH_BASE_URL 与 MOZI_BENCH_API_KEY 环境变量');
  }

  const providers = new ProviderRegistry();
  providers.register(
    new OpenAICompatibleProvider({
      baseUrl,
      apiKey: () => apiKey,
      model,
    }),
  );

  const sessionDir = join(workspaceDir, '.sessions');
  const engine = createEngine({
    sessionDir,
    workspaceRoot: workspaceDir,
    providers,
    approval: autoApproveGateway('allow'),
    policyMode: 'full-auto',
    enableSubAgents: true,
  });

  const instruction = readFileSync(join(task.dir, 'task.md'), 'utf8').trim();
  const sessionId = `bench-${task.id}-${Date.now().toString(36)}`;
  const stats = { steps: 0, toolCalls: 0, approvals: 0, usage: null, finishReason: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`task timed out after ${MAX_MS}ms`)), MAX_MS);

  try {
    for await (const ev of engine.run({ sessionId, text: instruction, signal: ac.signal })) {
      if (ev.type === 'tool.requested') stats.toolCalls += 1;
      else if (ev.type === 'tool.approval.required') stats.approvals += 1;
      else if (ev.type === 'turn.completed') {
        stats.steps = ev.steps;
        stats.usage = ev.usage;
      } else if (ev.type === 'task.completed') stats.finishReason = ev.reason;
      else if (ev.type === 'error')
        stats.finishReason = stats.finishReason ?? `error:${ev.error?.code}`;
    }
  } finally {
    clearTimeout(timer);
    try {
      engine.abort(sessionId);
    } catch {
      /* 会话已结束 */
    }
  }
  return stats;
}

// ---------- 单任务执行 ----------
async function runTask(task) {
  const workspaceDir = join(WORK_DIR, task.id);
  freshDir(workspaceDir);
  const record = {
    id: task.id,
    level: task.level,
    mode: MODE,
    status: 'fail',
    durationMs: 0,
    steps: null,
    toolCalls: null,
    approvals: null,
    usage: null,
    finishReason: null,
    error: null,
  };
  const started = Date.now();
  try {
    // 1) setup
    const setup = runNode(join(task.dir, 'setup.mjs'), workspaceDir, MAX_MS);
    if (setup.status !== 0) {
      record.error = `setup failed: ${(setup.stderr || setup.stdout || '').slice(0, 500)}`;
      return record;
    }

    // 2) 执行主体
    if (MODE === 'smoke') {
      const solutionDir = join(task.dir, 'solution');
      if (!existsSync(solutionDir)) {
        record.error = 'smoke 模式要求任务提供 solution/ 参考解';
        return record;
      }
      copyDir(solutionDir, workspaceDir);
    } else {
      const stats = await runEngine(task, workspaceDir);
      record.steps = stats.steps;
      record.toolCalls = stats.toolCalls;
      record.approvals = stats.approvals;
      record.usage = stats.usage;
      record.finishReason = stats.finishReason;
    }

    // 3) 断言
    const check = runNode(join(task.dir, 'asserts', 'check.mjs'), workspaceDir, MAX_MS);
    record.status = check.status === 0 ? 'pass' : 'fail';
    if (check.status !== 0) {
      record.error = (check.stderr || check.stdout || 'asserts failed').slice(0, 1000);
    }
  } catch (e) {
    record.status = 'error';
    record.error = String(e?.message ?? e).slice(0, 1000);
  } finally {
    record.durationMs = Date.now() - started;
  }
  return record;
}

// ---------- 汇总 ----------
function summarize(records) {
  const byLevel = {};
  for (const lv of LEVELS) {
    const rs = records.filter((r) => r.level === lv);
    if (rs.length === 0) continue;
    byLevel[lv] = { total: rs.length, passed: rs.filter((r) => r.status === 'pass').length };
  }
  const passed = records.filter((r) => r.status === 'pass');
  const avg = (nums) =>
    nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
  return {
    mode: MODE,
    model: MODE === 'live' ? process.env.MOZI_BENCH_MODEL || 'deepseek-chat' : null,
    date: new Date().toISOString(),
    total: records.length,
    passed: passed.length,
    successRate: records.length ? Number((passed.length / records.length).toFixed(4)) : 0,
    avgDurationMs: avg(records.map((r) => r.durationMs)),
    avgSteps: avg(passed.map((r) => r.steps).filter((n) => typeof n === 'number')),
    totalInputTokens: records.reduce((a, r) => a + (r.usage?.inputTokens ?? 0), 0),
    totalOutputTokens: records.reduce((a, r) => a + (r.usage?.outputTokens ?? 0), 0),
    totalCostUsd: Number(records.reduce((a, r) => a + (r.usage?.costUsd ?? 0), 0).toFixed(4)),
    totalApprovals: records.reduce((a, r) => a + (r.approvals ?? 0), 0),
    byLevel,
  };
}

function writeMarkdown(summary, records, file) {
  const lines = [];
  lines.push('# Mozi Benchmark 跑分报告');
  lines.push('');
  lines.push(
    `- 模式：\`${summary.mode}\`${summary.model ? `（模型：\`${summary.model}\`）` : '（参考解自洽验证）'}`,
  );
  lines.push(`- 日期：${summary.date}`);
  lines.push(
    `- 成功率：**${summary.passed}/${summary.total}（${(summary.successRate * 100).toFixed(1)}%）**`,
  );
  if (summary.mode === 'live') {
    lines.push(
      `- 平均步数：${summary.avgSteps}｜token：in ${summary.totalInputTokens} / out ${summary.totalOutputTokens}｜成本 $${summary.totalCostUsd}｜审批 ${summary.totalApprovals} 次`,
    );
  }
  lines.push('');
  lines.push(
    `| 任务 | 级别 | 状态 | 耗时(ms)${summary.mode === 'live' ? ' | 步数 | 工具调用 | token(in/out) | 审批' : ''} |`,
  );
  lines.push(
    `|------|------|------|----------${summary.mode === 'live' ? '|------|----------|----------------|------' : ''}|`,
  );
  for (const r of records) {
    const extra =
      summary.mode === 'live'
        ? ` | ${r.steps ?? '-'} | ${r.toolCalls ?? '-'} | ${r.usage?.inputTokens ?? 0}/${r.usage?.outputTokens ?? 0} | ${r.approvals ?? 0}`
        : '';
    lines.push(
      `| ${r.id} | ${r.level} | ${r.status === 'pass' ? '✅' : '❌'} | ${r.durationMs}${extra} |`,
    );
  }
  lines.push('');
  for (const [lv, s] of Object.entries(summary.byLevel)) {
    lines.push(`- ${lv}：${s.passed}/${s.total}`);
  }
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

// ---------- main ----------
async function main() {
  const tasks = discover();
  if (tasks.length === 0) {
    console.error('未发现任何任务（检查 tasks/ 目录与过滤条件）');
    process.exit(1);
  }
  console.log(
    `mozi benchmark：${tasks.length} 个任务，模式 ${MODE}${LEVEL_FILTER ? `，级别 ${LEVEL_FILTER}` : ''}${TASK_FILTER ? `，任务 ${TASK_FILTER}` : ''}\n`,
  );

  const records = [];
  for (const task of tasks) {
    process.stdout.write(`  [${task.level}] ${task.id} ... `);
    const r = await runTask(task);
    records.push(r);
    const mark = r.status === 'pass' ? '✅' : '❌';
    const extra = r.error ? ` —— ${r.error.split('\n')[0].slice(0, 120)}` : '';
    console.log(`${mark} ${r.durationMs}ms${extra}`);
  }

  const summary = summarize(records);
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonFile = join(OUT_DIR, `${stamp}-${MODE}.json`);
  const mdFile = join(OUT_DIR, `${stamp}-${MODE}.md`);
  writeFileSync(jsonFile, JSON.stringify({ summary, tasks: records }, null, 2), 'utf8');
  writeMarkdown(summary, records, mdFile);

  console.log(
    `\n成功率：${summary.passed}/${summary.total}（${(summary.successRate * 100).toFixed(1)}%）`,
  );
  for (const [lv, s] of Object.entries(summary.byLevel)) {
    console.log(`  ${lv}: ${s.passed}/${s.total}`);
  }
  console.log(`\n报告：${jsonFile}\n      ${mdFile}`);

  // 清理工作区（保留最近一次便于排查：live 失败时保留全部）
  if (records.every((r) => r.status === 'pass')) {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
  process.exit(records.every((r) => r.status === 'pass') ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
