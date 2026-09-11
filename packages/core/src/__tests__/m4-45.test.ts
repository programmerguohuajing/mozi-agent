import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  TaskLocks,
  TaskScheduler,
  TaskStore,
  buildUnattendedPolicy,
  countMissedRuns,
  maskSecret,
  nextRunAt,
  parseCron,
  planTick,
  runHeadless,
  sendWebhook,
  validateTaskConfig,
  type TaskSpec,
} from '@mozi/core';
import { PolicyEngine } from '@mozi/policy';
import { ProviderRegistry, ScriptedProvider, type ScriptedTurn } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
/**
 * M4.5 定时任务与调度测试（M13 §13.11）：
 * 调度求解（cron/时区/interval/once + 错过补跑）、任务存储、无人值守策略不变式（I1/I3/I4）、
 * 三层锁、通知 webhook、tick 主循环、worktree 产物流程、headless 执行链路。
 */

function makeProvider(turns: ScriptedTurn[]): ProviderRegistry {
  const reg = new ProviderRegistry();
  const p = new ScriptedProvider(turns, 'scripted', 'scripted-model');
  reg.register(p);
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

function baseSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-test',
    name: '测试任务',
    prompt: '做一件事',
    workspace: '/tmp/workspace',
    schedule: { kind: 'cron', expression: '* * * * *' },
    config: { policy: { mode: 'readonly' }, artifact: 'report-only' },
    enabled: true,
    createdAt: new Date().toISOString(),
    state: { consecutiveFailures: 0, totalRuns: 0 },
    ...overrides,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m45-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 调度求解：cron / interval / once + 补跑 ──

describe('cron 求解', () => {
  it('解析 5 字段（步进/列表/周 0 与 7 归一）', () => {
    const c = parseCron('*/15 9-17 1,15 * 0,6');
    expect(c.minute.has(0)).toBe(true);
    expect(c.minute.has(15)).toBe(true);
    expect(c.minute.has(45)).toBe(true);
    expect(c.hour.has(9)).toBe(true);
    expect(c.hour.has(17)).toBe(true);
    expect(c.dom.has(1)).toBe(true);
    expect(c.dom.has(15)).toBe(true);
    expect(c.dow.has(0)).toBe(true);
    expect(c.dow.has(6)).toBe(true);
  });

  it('nextRunAfter：每 5 分钟 → 下一触发', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const next = nextTaskRun('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });

  it('跨天：23:59 后 → 次日 00:00', () => {
    const from = new Date('2026-01-01T23:59:30Z');
    const next = nextTaskRunAt('0 0 * * *', from, 'UTC');
    expect(next.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('月末：1 月 31 日 23:59 后 → 2 月 1 日（cron 自动进位）', () => {
    const from = new Date('2026-01-31T23:59:00Z');
    const next = nextTaskRunAt('0 0 1 * *', from, 'UTC');
    expect(next.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('时区：Asia/Shanghai 09:00 = UTC 01:00', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const next = nextTaskRunAt('0 9 * * *', from, 'Asia/Shanghai');
    expect(next.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('interval 对齐整分钟；once 过期返回 from', () => {
    const from = new Date('2026-01-01T10:03:30Z');
    expect(nextRunAt({ kind: 'interval', everyMinutes: 15 }, from).toISOString()).toBe('2026-01-01T10:19:00.000Z');
    const future = new Date('2026-12-31T00:00:00Z');
    expect(nextRunAt({ kind: 'once', at: '2026-12-31T00:00:00Z' }, from).getTime()).toBe(future.getTime());
    expect(nextRunAt({ kind: 'once', at: '2020-01-01T00:00:00Z' }, from).getTime()).toBe(from.getTime());
  });
});

function nextTaskRun(expr: string, from: Date): Date {
  return nextRunAt({ kind: 'cron', expression: expr }, from);
}
function nextTaskRunAt(expr: string, from: Date, tz: string): Date {
  return nextRunAt({ kind: 'cron', expression: expr, timeZone: tz }, from);
}

describe('错过补跑策略', () => {
  it('首次调度 → 求解 nextRunAt', () => {
    const spec = baseSpec();
    const plan = planTick(spec, new Date('2026-01-01T00:00:00Z'));
    expect(plan.shouldRun).toBe(false);
    expect(plan.nextAt > new Date('2026-01-01T00:00:00Z')).toBe(true);
  });

  it('到期 → due 触发并推进', () => {
    const spec = baseSpec({
      state: {
        consecutiveFailures: 0,
        totalRuns: 0,
        nextRunAt: '2026-01-01T00:00:00Z',
        lastRunAt: '2025-12-31T23:55:00Z',
      },
    });
    const plan = planTick(spec, new Date('2026-01-01T00:01:00Z'));
    expect(plan.shouldRun).toBe(true);
    expect(plan.note).toBe('due');
  });

  it('关机错过 N 次：skip / catch-up-once / catch-up-all', () => {
    const spec = baseSpec({
      state: {
        consecutiveFailures: 0,
        totalRuns: 0,
        nextRunAt: '2026-01-01T00:05:00Z',
        lastRunAt: '2026-01-01T00:00:00Z',
      },
    });
    const now = new Date('2026-01-01T00:35:00Z'); // 错过 6 个周期（period 5min）
    expect(countMissedRuns(spec, now)).toBe(6);
    const skip = planTick(spec, now, 'skip');
    expect(skip.shouldRun).toBe(false);
    expect(skip.note).toMatch(/missed-skip/);
    const once = planTick(spec, now, 'catch-up-once');
    expect(once.shouldRun).toBe(true);
    expect(once.note).toMatch(/catch-up-once/);
    expect(once.missed).toBe(6);
    const all = planTick(spec, now, 'catch-up-all');
    expect(all.shouldRun).toBe(true);
    expect(all.missed).toBe(6);
  });
});

// ── 无人值守策略：I1 / I3 / I4 ──

describe('无人值守安全模型', () => {
  it('I1：readonly 下写操作一律 deny；read 允许', () => {
    const build = buildUnattendedPolicy({ mode: 'readonly' });
    const engine = new PolicyEngine([]);
    const conf = { mode: build.policyMode, rules: build.rules };
    expect(engine.evaluate({ id: 'a', name: 'write_file', riskLevel: 'write', arguments: {} }, conf, build.evaluateOptions).type).toBe('deny');
    expect(engine.evaluate({ id: 'b', name: 'read_file', riskLevel: 'read', arguments: {} }, conf, build.evaluateOptions).type).toBe('allow');
  });

  it('allowlist：白名单内 allow、白名单外 deny、高危命令不可绕过（I3）', () => {
    const build = buildUnattendedPolicy({
      mode: 'allowlist',
      allowlist: { commands: ['npm test', 'git status'], writePathGlobs: ['src/**'] },
    });
    const engine = new PolicyEngine([]); // builtin 已并入 rules
    const conf = { mode: build.policyMode, rules: build.rules };
    const ev = (name: string, args: Record<string, unknown>, risk: string = 'exec') =>
      engine.evaluate({ id: 'c', name, riskLevel: risk, arguments: args }, conf, build.evaluateOptions);
    expect(ev('shell', { command: 'npm test' }).type).toBe('allow');
    expect(ev('shell', { command: 'git status' }).type).toBe('allow');
    expect(ev('shell', { command: 'echo hi' }).type).toBe('deny');
    // 内置高危：即使显式允许 rm -rf 也不可绕过
    expect(ev('shell', { command: 'rm -rf /' }).type).toBe('deny');
    expect(ev('write_file', { path: 'src/a.ts' }, 'write').type).toBe('allow');
    expect(ev('write_file', { path: 'other.txt' }, 'write').type).toBe('deny');
  });

  it('I4：full + sandbox<3 拒绝创建；full+direct 拒绝；allowlist 空名单拒绝', () => {
    expect(validateTaskConfig({ policy: { mode: 'full' }, artifact: 'branch', sandboxLevel: 2 }).ok).toBe(false);
    expect(validateTaskConfig({ policy: { mode: 'full' }, artifact: 'direct', sandboxLevel: 3 }).ok).toBe(false);
    expect(validateTaskConfig({ policy: { mode: 'allowlist', allowlist: {} }, artifact: 'report-only' }).ok).toBe(false);
    expect(validateTaskConfig({ policy: { mode: 'full' }, artifact: 'branch', sandboxLevel: 3 }).ok).toBe(true);
  });
});

// ── 存储与原子写 ──

describe('TaskStore', () => {
  it('add/get/remove/load 持久化', () => {
    const file = path.join(tmp, 'tasks.json');
    const store = new TaskStore(file);
    const spec = baseSpec({ id: 'task-a', name: 'A' });
    store.add(spec);
    expect(store.get('task-a')?.name).toBe('A');
    store.update('task-a', { name: 'A2' });
    expect(new TaskStore(file).get('task-a')?.name).toBe('A2');
    store.remove('task-a');
    expect(store.get('task-a')).toBeUndefined();
  });

  it('损坏主文件 → 从 .bak 恢复', () => {
    const file = path.join(tmp, 'tasks.json');
    // 隔离：清掉可能由其它用例遗留的主文件与备份
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
    const store = new TaskStore(file);
    store.add(baseSpec({ id: 'task-x' })); // 写主文件（无旧文件 → 不生成 .bak）
    store.update('task-x', { name: 'X' }); // 第二次写 → 主文件备份为 .bak
    fs.writeFileSync(file, '{broken json'); // 损坏主文件
    const recovered = new TaskStore(file).load(); // 应从 .bak 恢复
    expect(recovered.find((t) => t.id === 'task-x')).toBeTruthy();
  });
});

// ── 三层文件锁 ──

describe('TaskLocks', () => {
  it('互斥：第二次 acquire 失败；释放后可再获取', async () => {
    const locks = new TaskLocks(path.join(tmp, 'locks'));
    expect(await locks.acquire('tick', 'a', 1_000)).toBe(true);
    expect(await locks.acquire('tick', 'b', 300)).toBe(false);
    locks.release('tick');
    expect(await locks.acquire('tick', 'c', 1_000)).toBe(true);
    locks.release('tick');
  });

  it('僵尸锁（持有进程不存在）→ 可抢占', async () => {
    const locks = new TaskLocks(path.join(tmp, 'locks'));
    await locks.acquire('task_x', 'first', 1_000);
    // 模拟持有者已死：改 holder pid
    const holder = path.join(tmp, 'locks', 'task_x.lock', 'holder.json');
    fs.writeFileSync(holder, JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 10 }));
    expect((await locks.acquire('task_x', 'second', 1_000))).toBe(true);
    locks.release('task_x');
  });
});

// ── 通知 ──

describe('通知', () => {
  it('maskSecret 脱敏密钥字段', () => {
    const out = maskSecret({ apiKey: 'sk-123', nested: { token: 'abc', ok: 1 } }) as Record<string, unknown>;
    expect(out.apiKey).toBe('***');
    expect((out.nested as Record<string, unknown>).token).toBe('***');
  });

  it('webhook POST：本地 http server 收到载荷', async () => {
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await sendWebhook(`http://127.0.0.1:${port}/hook`, {
        event: 'task.failed',
        taskId: 'task-1',
        taskName: 't',
        status: 'failed',
        startedAt: 'x',
        endedAt: 'y',
      });
      expect(res.ok).toBe(true);
      expect((received[0] as { taskId: string }).taskId).toBe('task-1');
    } finally {
      server.close();
    }
  });
});

// ── tick 主循环 + 熔断 + headless 执行 ──

function specFor(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return baseSpec({
    workspace: tmp,
    ...overrides,
  });
}

describe('tick 主循环', () => {
  it('到期任务被触发并执行（ScriptedProvider）', async () => {
    const runsDir = path.join(tmp, 'runs');
    const locksDir = path.join(tmp, 'locks');
    const workDir = path.join(tmp, 'wt');
    const store = new TaskStore(path.join(tmp, 'tasks.json'));
    store.add(
      specFor({
        id: 'task-tick',
        schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    const scheduler = new TaskScheduler({
      store,
      runsDir,
      locksDir,
      worktreesDir: workDir,
      providers: () => makeProvider([{ content: '完成' }]),
      clock: () => new Date(),
    });
    const result = await scheduler.tick();
    expect(result.triggered.length).toBe(1);
    const runs = fs.readdirSync(path.join(runsDir, 'task-tick'));
    expect(runs.length).toBeGreaterThan(0);
    // report 与 json 落盘
    expect(runs.some((r) => r.endsWith('.json'))).toBe(true);
    // 任务状态已更新
    const updated = store.get('task-tick');
    expect(updated?.state.lastStatus).toBe('success');
    expect(updated?.state.totalRuns).toBe(1);
  });

  it('once 任务跑完后自动 disable', async () => {
    const runsDir = path.join(tmp, 'runs');
    const store = new TaskStore(path.join(tmp, 'tasks.json'));
    store.add(specFor({ id: 'task-once', schedule: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() } }));
    const scheduler = new TaskScheduler({
      store,
      runsDir,
      locksDir: path.join(tmp, 'locks'),
      worktreesDir: path.join(tmp, 'wt'),
      providers: () => makeProvider([{ content: '完成' }]),
      clock: () => new Date(),
    });
    await scheduler.tick();
    expect(store.get('task-once')?.enabled).toBe(false);
  });

  it('worktree 产物：改动 commit 到 mozi/task/* 分支，worktree 被清理', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    const store = new TaskStore(path.join(tmp, 'tasks.json'));
    store.add(
      baseSpec({
        id: 'task-wt',
        workspace: repo,
        config: { policy: { mode: 'allowlist', allowlist: { writePathGlobs: ['**'] } }, artifact: 'branch' },
        schedule: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() },
      }),
    );
    const runsDir = path.join(tmp, 'runs');
    const wtDir = path.join(tmp, 'wt');
    const scheduler = new TaskScheduler({
      store,
      runsDir,
      locksDir: path.join(tmp, 'locks'),
      worktreesDir: wtDir,
      providers: () =>
        makeProvider([
          { toolCalls: [{ name: 'write_file', arguments: { path: 'new.txt', content: 'created' } }] },
          { content: '完成' },
        ]),
      clock: () => new Date(),
    });
    await scheduler.tick();
    // worktree 已清理（rm）
    expect(fs.readdirSync(wtDir)).toHaveLength(0);
    // 分支存在且包含新文件
    const branches = git(repo, 'branch', '--list', 'mozi/task/*');
    expect(branches.stdout).toContain('task-wt');
  });
});

describe('headless 执行', () => {
  it('ScriptedProvider 驱动：成功状态 + 报告生成', async () => {
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'hello.txt'), 'mozi');
    const spec = specFor({ id: 'task-h', workspace: ws });
    const out = await runHeadless({
      spec,
      runId: 'run-1',
      workspaceDir: ws,
      providers: makeProvider([
        { toolCalls: [{ name: 'read_file', arguments: { path: 'hello.txt' } }] },
        { content: '读取完成' },
      ]),
      sessionDir: path.join(tmp, 'sessions'),
    });
    expect(out.exitCode).toBe(0);
    expect(out.summary).toContain('读取完成');
  });
});

function git(repo: string, ...args: string[]) {
  return { stdout: execFileSync('git', args, { cwd: repo, encoding: 'utf8' }) };
}