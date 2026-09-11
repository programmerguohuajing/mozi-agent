/**
 * mozi task 子命令族（M4.5 / M13 §13.9）：add / list / rm / enable / disable / run / logs / tick / gc / doctor。
 * 业务逻辑全部复用 @mozi/core 的 TaskStore / TaskScheduler / 调度求解。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import {
  TaskLocks,
  TaskScheduler,
  TaskStore,
  newTaskId,
  nextRunAt,
  validateTaskConfig,
  type MissedPolicy,
  type Schedule,
  type TaskSpec,
} from '@mozi/core';
import { OpenAICompatibleProvider } from '@mozi/providers';

export const HOME = os.homedir();
export const TASKS_DIR = process.env.MOZI_TASKS_DIR ?? path.join(HOME, '.mozi', 'tasks');
export const TASKS_FILE = path.join(TASKS_DIR, 'tasks.json');
export const RUNS_DIR = path.join(TASKS_DIR, 'runs');
export const LOCKS_DIR = path.join(TASKS_DIR, 'locks');
export const WORKTREES_DIR = path.join(TASKS_DIR, 'worktrees');

function buildProviders() {
  const reg = new ProviderRegistry();
  const base = process.env.MOZI_BASE_URL;
  const key = process.env.MOZI_API_KEY;
  const model = process.env.MOZI_MODEL ?? 'deepseek-chat';
  if (base && key) {
    reg.register(new OpenAICompatibleProvider({ baseUrl: base, apiKey: () => key, model }));
    reg.alias('executor', model).alias('deepseek-chat', model).alias(model, model);
    return { reg, model, live: true };
  }
  const demo = new ScriptedProvider(
    [{ content: '（离线演示）定时任务已运行。配置 MOZI_BASE_URL / MOZI_API_KEY 后接入真实模型。' }],
    'demo',
    model,
  );
  reg.register(demo);
  reg.alias('executor', 'demo').alias('deepseek-chat', 'demo').alias(model, 'demo');
  return { reg, model, live: false };
}

export interface TaskAddArgs {
  name: string;
  prompt: string;
  workspace: string;
  cron?: string;
  every?: number;
  at?: string;
  timezone?: string;
  policy?: 'readonly' | 'allowlist' | 'full';
  allowCmd?: string[];
  allowPath?: string[];
  artifact?: 'report-only' | 'branch' | 'pr' | 'direct';
  sandbox?: 0 | 1 | 2 | 3;
  template?: string;
  model?: string;
  notifyWebhook?: string;
  notifyOn?: string;
  maxSteps?: number;
  maxCost?: number;
  timeoutMs?: number;
  missed?: string;
}

export function taskAdd(args: TaskAddArgs): TaskSpec {
  const schedule: Schedule = args.cron
    ? { kind: 'cron', expression: args.cron, timeZone: args.timezone }
    : args.every
      ? { kind: 'interval', everyMinutes: Number(args.every) }
      : args.at
        ? { kind: 'once', at: args.at }
        : (() => {
            throw new Error('必须指定 --cron / --every / --at 之一');
          })();

  const spec: TaskSpec = {
    id: newTaskId(),
    name: args.name || 'untitled',
    prompt: args.prompt,
    workspace: path.resolve(args.workspace || process.cwd()),
    schedule,
    config: {
      model: args.model,
      agentTemplate: args.template,
      policy: {
        mode: args.policy ?? 'readonly',
        allowlist:
          args.policy === 'allowlist' || args.allowCmd?.length || args.allowPath?.length
            ? {
                commands: args.allowCmd,
                writePathGlobs: args.allowPath,
              }
            : undefined,
      },
      artifact: args.artifact ?? 'report-only',
      sandboxLevel: args.sandbox,
      maxSteps: args.maxSteps,
      maxCostUsd: args.maxCost,
      timeoutMs: args.timeoutMs,
    },
    notifications:
      args.notifyWebhook || args.notifyOn
        ? {
            on: (args.notifyOn?.split(',') as Array<'completed' | 'failed'>) ?? ['failed'],
            webhook: args.notifyWebhook,
          }
        : undefined,
    enabled: true,
    createdAt: new Date().toISOString(),
    state: { consecutiveFailures: 0, totalRuns: 0 },
  };

  const check = validateTaskConfig(spec.config);
  if (!check.ok) throw new Error(`任务配置校验失败：\n${check.errors.map((e) => `  - ${e}`).join('\n')}`);
  const store = new TaskStore(TASKS_FILE);
  store.add(spec);
  return spec;
}

export function taskList(): TaskSpec[] {
  return new TaskStore(TASKS_FILE).load();
}

export function taskRemove(id: string): boolean {
  return new TaskStore(TASKS_FILE).remove(id);
}

export function taskSetEnabled(id: string, enabled: boolean): TaskSpec | undefined {
  return new TaskStore(TASKS_FILE).setEnabled(id, enabled);
}

export async function taskRun(id: string, now = false): Promise<void> {
  const scheduler = newTaskScheduler();
  if (now) {
    const result = await scheduler.runNow(id);
    console.log(
      `${result.record.status} run=${result.record.runId} steps=${result.record.steps ?? '-'} token=${result.record.usage?.totalTokens ?? 0}${result.record.artifacts?.branch ? ` branch=${result.record.artifacts.branch}` : ''}${result.disabledByCircuitBreaker ? '（已熔断停用）' : ''}`,
    );
    return;
  }
  // 不带 --now：视为「当前 tick 立即执行一次到期任务」
  const result = await scheduler.tick();
  if (result.locked) {
    console.error('tick 锁被占用（另一调度进程正在运行），跳过本次 tick。');
  }
  console.log(`tick：触发 ${result.triggered}，跳过 overlap ${result.skippedOverlap}，补跑 ${result.missed}，停用 ${result.disabled}`);
}

export async function taskTick(quiet = false): Promise<number> {
  const scheduler = newTaskScheduler();
  const result = await scheduler.tick();
  if (quiet) return result.triggered.length;
  if (result.locked) {
    console.log('tick 锁被占用，跳过（另一触发源正在运行）。');
    return 0;
  }
  console.log(`tick 完成：触发 ${result.triggered} 个任务，补跑 ${result.missed} 次，跳过 overlap ${result.skippedOverlap.length}`);
  return result.triggered.length;
}

export async function taskDoctor(): Promise<number> {
  const store = new TaskStore(TASKS_FILE);
  const locks = new TaskLocks(LOCKS_DIR);
  const tasks = store.load();
  const lines: string[] = ['[mozi task doctor]'];
  lines.push(`- tasks.json：${TASKS_FILE}（${tasks.length} 个任务）`);
  for (const t of tasks) {
    const next = t.state.nextRunAt ? new Date(t.state.nextRunAt) : nextRunAt(t.schedule, new Date());
    lines.push(`  · ${t.id} ${t.enabled ? 'enabled' : 'DISABLED'} 下次=${next.toISOString()} 连续失败=${t.state.consecutiveFailures} 上次=${t.state.lastStatus ?? '-'}`);
  }
  for (const name of ['tick']) {
    const info = locks.info(name);
    lines.push(`锁 ${name}：${info.held ? `被 pid=${info.holder?.pid} 持有` : info.stale ? '僵尸锁（可抢占）' : '空闲'}`);
  }
  lines.push(`运行记录：${fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).length + ' 个任务目录' : '无'}`);
  console.log(lines.join('\n'));
  return 0;
}

export function taskGc(): void {
  // 清理孤儿 worktree 与临时快照
  if (!fs.existsSync(WORKTREES_DIR)) return;
  let removed = 0;
  for (const entry of fs.readdirSync(WORKTREES_DIR)) {
    const p = path.join(WORKTREES_DIR, entry);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 占用中 */
    }
  }
  if (removed) console.log(`已清理 ${removed} 个临时 worktree/快照目录。`);
  else console.log('无孤儿 worktree。');
}

export function newTaskScheduler(missedPolicy?: string): TaskScheduler {
  return new TaskScheduler({
    store: new TaskStore(TASKS_FILE),
    runsDir: RUNS_DIR,
    locksDir: LOCKS_DIR,
    worktreesDir: WORKTREES_DIR,
    providers: () => buildProviders().reg,
    missedPolicy: (missedPolicy as MissedPolicy) ?? 'catch-up-once',
  });
}

// ── commander 注册（M13 §13.9 CLI）──

export function registerTaskCommands(program: import('commander').Command): void {
  const task = program.command('task').description('定时任务与无人值守（M4.5）');

  task
    .command('add')
    .description('创建定时任务（交互向导暂由选项完成）')
    .option('--name <name>', '任务名称')
    .option('--prompt <prompt>', '任务指令（自包含）')
    .option('--workspace <dir>', '目标仓库', process.cwd())
    .option('--cron <expr>', '5 字段 cron 表达式（如 "0 9 * * 1-5"）')
    .option('--every <minutes>', '固定间隔（分钟，>=10）')
    .option('--at <iso>', '一次性时刻（ISO8601）')
    .option('--timezone <tz>', 'cron 时区（默认系统时区）')
    .option('--policy <mode>', '无人值守策略: readonly|allowlist|full', 'readonly')
    .option('--allow-cmd <cmd...>', 'allowlist 允许的命令前缀')
    .option('--allow-path <glob...>', 'allowlist 可写路径 glob')
    .option('--artifact <kind>', '产物策略: report-only|branch|pr|direct', 'report-only')
    .option('--sandbox <level>', '沙箱等级 0-3')
    .option('--template <name>', 'agent 模板（reviewer/explore/自定义）')
    .option('--model <name>', '覆盖 executor 模型')
    .option('--notify-webhook <url>', '失败/完成通知 webhook')
    .option('--notify-on <list>', '通知时机: completed,failed')
    .option('--max-steps <n>', '最大步数（默认 30）')
    .option('--max-cost <usd>', '单次成本上限（默认 $1）')
    .option('--timeout-ms <n>', '单次超时毫秒')
    .action(async (opts) => {
      try {
        const spec = taskAdd({
          name: opts.name ?? 'untitled',
          prompt: opts.prompt ?? '',
          workspace: opts.workspace,
          cron: opts.cron,
          every: opts.every ? Number(opts.every) : undefined,
          at: opts.at,
          timezone: opts.timezone,
          policy: opts.policy,
          allowCmd: opts.allowCmd,
          allowPath: opts.allowPath,
          artifact: opts.artifact,
          sandbox: opts.sandbox !== undefined ? (Number(opts.sandbox) as 0 | 1 | 2 | 3) : undefined,
          template: opts.template,
          model: opts.model,
          notifyWebhook: opts.notifyWebhook,
          notifyOn: opts.notifyOn,
          maxSteps: opts.maxSteps !== undefined ? Number(opts.maxSteps) : undefined,
          maxCost: opts.maxCost !== undefined ? Number(opts.maxCost) : undefined,
          timeoutMs: opts.timeoutMs !== undefined ? Number(opts.timeoutMs) : undefined,
        });
        const next = nextRunAt(spec.schedule, new Date());
        console.log(`已创建任务 ${spec.id}（${spec.name}）`);
        console.log(`  策略=${spec.config.policy.mode} 产物=${spec.config.artifact}`);
        console.log(`  下次运行：${next.toISOString()}`);
      } catch (e) {
        console.error(`创建失败：${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  task.command('list').description('列出全部任务').action(() => {
    const tasks = taskList();
    if (!tasks.length) {
      console.log('（无任务）');
      return;
    }
    for (const t of tasks) {
      const next = t.state.nextRunAt ? new Date(t.state.nextRunAt) : nextRunAt(t.schedule, new Date());
      console.log(
        `${t.id}  ${t.enabled ? '✓' : '✗'}  ${t.name.padEnd(16)} 下次=${next.toISOString().slice(0, 16)}  上次=${t.state.lastStatus ?? '-'}  连续失败=${t.state.consecutiveFailures}`,
      );
    }
  });

  task.command('rm <id>').description('删除任务').action((id: string) => {
    if (taskRemove(id)) console.log(`已删除 ${id}`);
    else {
      console.error(`任务不存在：${id}`);
      process.exitCode = 1;
    }
  });

  task.command('enable <id>').description('启用任务').action((id: string) => {
    const t = taskSetEnabled(id, true);
    if (t) console.log(`已启用 ${id}`);
    else process.exitCode = 1;
  });

  task.command('disable <id>').description('暂停任务（保留配置）').action((id: string) => {
    const t = taskSetEnabled(id, false);
    if (t) console.log(`已暂停 ${id}`);
    else process.exitCode = 1;
  });

  task
    .command('run <id>')
    .description('手动触发（--now 立即执行；否则执行一轮 tick）')
    .option('--now', '立即执行该任务')
    .action(async (id: string, opts) => {
      try {
        await taskRun(id, opts.now ?? false);
      } catch (e) {
        console.error(`运行失败：${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  task
    .command('tick')
    .description('调度心跳（OS 注册的就是它；幂等）')
    .option('--quiet', '安静模式')
    .action(async (opts) => {
      const n = await taskTick(opts.quiet ?? false);
      if (opts.quiet) process.exitCode = n ? 0 : 0;
    });

  task.command('doctor').description('调度自检（OS 注册/锁健康/任务清单）').action(async () => {
    await taskDoctor();
  });

  task.command('gc').description('清理孤儿 worktree 与临时产物').action(() => taskGc());
}