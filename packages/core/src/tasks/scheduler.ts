/**
 * tick 主循环（M4.5 / M13 §13.4 / §13.7 / §13.10）：OS 每分钟唤醒 `mozi task tick`，
 * 内部 cron 求解 + 三层锁 + 触发执行 + 错过补跑 + 连续失败熔断 + 通知。
 */
import { mkdirSync } from 'node:fs';
import type { ProviderRegistry } from '@mozi/providers';
import { TaskStore } from './store.js';
import { TaskLocks } from './locks.js';
import { nextRunAt, planTick } from './solver.js';
import { buildWebhookPayload, sendWebhook } from './notify.js';
import { executeTaskOnce } from './runner.js';
import type { MissedPolicy, RunRecord, TaskSpec } from './types.js';
import { DEFAULT_TASK_OPTIONS } from './types.js';

export interface SchedulerOptions {
  store: TaskStore;
  runsDir: string;
  locksDir: string;
  worktreesDir: string;
  /** 提供 providers（惰性求值：tick 每次执行时取） */
  providers: () => ProviderRegistry;
  missedPolicy?: MissedPolicy;
  clock?: () => Date;
  /** 任务运行事件流出口（CLI/桌面可监听） */
  onEvent?: (ev: unknown) => void;
}

export interface TickResult {
  locked: boolean;
  triggered: string[];
  skippedOverlap: string[];
  missed: number;
  disabled: string[];
  errors: string[];
}

export interface RunTaskResult {
  record: RunRecord;
  task: TaskSpec;
  disabledByCircuitBreaker: boolean;
}

const FAILURE_LIMIT = 3; // 连续失败熔断阈值（13.10）

export class TaskScheduler {
  private readonly locks: TaskLocks;
  private readonly store: TaskStore;
  private readonly runsDir: string;
  private readonly worktreesDir: string;
  private readonly providers: () => ProviderRegistry;
  private readonly missedPolicy: MissedPolicy;
  private readonly clock: () => Date;
  private readonly onEvent?: (ev: unknown) => void;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.runsDir = opts.runsDir;
    this.worktreesDir = opts.worktreesDir;
    this.providers = opts.providers;
    this.missedPolicy = opts.missedPolicy ?? DEFAULT_TASK_OPTIONS.missedPolicy;
    this.clock = opts.clock ?? (() => new Date());
    this.onEvent = opts.onEvent;
    mkdirSync(opts.runsDir, { recursive: true });
    mkdirSync(opts.worktreesDir, { recursive: true });
    this.locks = new TaskLocks(opts.locksDir);
  }

  /** tick 主循环：一次调用至多触发一轮到期任务 */
  async tick(): Promise<TickResult> {
    const result: TickResult = { locked: false, triggered: [], skippedOverlap: [], missed: 0, disabled: [], errors: [] };
    const now = this.clock();

    // L1 tick 锁：OS tick 与 daemon 并存时互斥；拿不到直接退出
    const lockAcquired = await this.locks.acquire('tick', 'tick-main', 1_000);
    if (!lockAcquired) {
      result.locked = true;
      return result;
    }
    try {
      const tasks = this.store.load();
      const updated: TaskSpec[] = [];
      for (const task of tasks) {
        if (!task.enabled) {
          updated.push(task);
          continue;
        }
        const plan = planTick(task, now, this.missedPolicy);
        // 先推进 nextRunAt（防执行中崩溃导致重复触发）
        const next: TaskSpec = {
          ...task,
          state: {
            ...task.state,
            nextRunAt: plan.nextAt.toISOString(),
            missedRuns: plan.missed || task.state.missedRuns,
          },
        };
        if (plan.missed > 0) result.missed += plan.missed;

        if (!plan.shouldRun) {
          updated.push(next);
          continue;
        }

        // L2 任务锁：同任务 overlap 防护（默认 skip）
        const taskLock = await this.locks.acquire(`task_${task.id}`, 'task-run', 1_000);
        if (!taskLock) {
          result.skippedOverlap.push(task.id);
          updated.push({ ...next, state: { ...next.state, lastStatus: 'skipped-overlap' } });
          continue;
        }
        try {
          const run = await this.runTask(next, 'schedule', plan.missed);
          result.triggered.push(task.id);
          if (run.disabledByCircuitBreaker) result.disabled.push(task.id);
          if (run.record.status !== 'success') result.errors.push(`${task.id}:${run.record.status}`);
          updated.push(run.task);
        } catch (e) {
          result.errors.push(`${task.id}:${String((e as Error).message ?? e)}`);
          updated.push(next);
        } finally {
          this.locks.release(`task_${task.id}`);
        }
      }
      this.store.save(updated);
    } finally {
      this.locks.release('tick');
    }
    return result;
  }

  /** 手动触发一次任务（mozi task run --now），与定时触发走同一执行链路 */
  async runNow(taskId: string): Promise<RunTaskResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    const lock = await this.locks.acquire(`task_${taskId}`, 'manual', 5_000);
    if (!lock) throw new Error(`任务正在运行中（${taskId}）`);
    try {
      const run = await this.runTask(task, 'manual', 0);
      // 手动触发后重新排程
      const nextAt = nextRunAt(task.schedule, new Date());
      const finalTask: TaskSpec = { ...run.task, state: { ...run.task.state, nextRunAt: nextAt.toISOString() } };
      this.store.update(finalTask.id, finalTask);
      return { ...run, task: finalTask };
    } finally {
      this.locks.release(`task_${taskId}`);
    }
  }

  /** 单任务执行编排：产物隔离执行 + 状态更新 + 熔断 + 通知 */
  private async runTask(task: TaskSpec, trigger: 'schedule' | 'manual', missedRuns: number): Promise<RunTaskResult> {
    const { record } = await executeTaskOnce(task, {
      providers: this.providers(),
      runsDir: this.runsDir,
      worktreesDir: this.worktreesDir,
      trigger,
      missedRuns,
      onEvent: this.onEvent,
    });

    const ok = record.status === 'success';
    const failures = ok ? 0 : task.state.consecutiveFailures + 1;
    const disabled = failures >= FAILURE_LIMIT;
    // once 任务跑完即停用（13.4：一次性任务触发一次后 disable）
    const onceDone = task.schedule.kind === 'once';
    const updated: TaskSpec = {
      ...task,
      enabled: task.enabled && !disabled && !onceDone,
      state: {
        ...task.state,
        lastRunAt: record.startedAt,
        lastRunId: record.runId,
        lastStatus: record.status,
        consecutiveFailures: failures,
        totalRuns: task.state.totalRuns + 1,
      },
    };

    // 更新 store（runTask 内部保存；tick 外层会再整体 save，幂等）
    const tasks = this.store.load().map((t) => (t.id === task.id ? updated : t));
    this.store.save(tasks);

    // 通知（completed / failed；熔断时也通知）
    await this.notify(task, record, disabled);

    return { record, task: updated, disabledByCircuitBreaker: disabled };
  }

  private async notify(task: TaskSpec, record: RunRecord, disabled: boolean): Promise<void> {
    const cfg = task.notifications;
    if (!cfg || !cfg.webhook) return;
    const on = cfg.on ?? [];
    const failed = record.status !== 'success';
    const should = (failed && on.includes('failed')) || (!failed && on.includes('completed')) || disabled;
    if (!should) return;
    const payload = buildWebhookPayload(record, task.name, {
      includeReport: cfg.includeReport ?? true,
    });
    await sendWebhook(cfg.webhook, payload, {});
  }
}

export { FAILURE_LIMIT };