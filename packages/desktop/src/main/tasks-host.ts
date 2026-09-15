/**
 * TaskSchedulerHost：主进程的定时任务宿主（M4.5 / M13 §13.4）。
 *
 * 组装 core 的 TaskScheduler + TaskStore：
 *   - 启动即加载 userData/tasks/tasks.json；每分钟 tick 一次（到期任务触发执行）
 *   - 手动「立即运行」（runNow，trigger=manual，不等待 cron 到期）
 *   - 任务运行事件经 emit 回调扇出（渲染端 SchedulePanel 实时更新状态）
 *
 * 任务执行链：executeTaskOnce → runHeadless（无人值守引擎，审批一律 deny）。
 */
import path from 'node:path';
import { type Schedule, TaskScheduler, type TaskSpec, TaskStore, newTaskId } from '@mozi/core';
import { nextRunAt } from '@mozi/core';
import type { ProviderRegistry } from '@mozi/providers';

/** 渲染端可见的任务视图（SchedulePanel 数据源）。 */
export interface ScheduleTaskView {
  id: string;
  name: string;
  /** 5 字段 cron 表达式（展示用）。 */
  cron: string;
  /** 下次执行（ISO；禁用时仍给出计算值）。 */
  nextRun: string;
  enabled: boolean;
  lastStatus: 'success' | 'failed' | 'pending' | 'never' | 'skipped-overlap' | 'timeout';
  /** 任务指令（编辑回显）。 */
  prompt?: string;
  /** 目标工作区。 */
  workspace?: string;
}

export interface TaskSchedulerHostOptions {
  /** 数据目录（userData）：tasks.json / runs / locks / worktrees 都在其下。 */
  dataDir: string;
  /** provider 注册表（任务执行时取当前实例）。 */
  providers: ProviderRegistry;
  /** 任务状态变化出口（渲染端刷新列表）。 */
  onTaskEvent?: () => void;
  /** 时钟注入（测试）。 */
  clock?: () => Date;
  /** tick 间隔（测试可调小；默认 60s）。 */
  tickMs?: number;
}

export class TaskSchedulerHost {
  readonly store: TaskStore;
  private readonly scheduler: TaskScheduler;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: TaskSchedulerHostOptions;
  /** 手动运行中的任务（防重复触发）。 */
  private readonly running = new Set<string>();

  constructor(opts: TaskSchedulerHostOptions) {
    this.opts = opts;
    this.store = new TaskStore(path.join(opts.dataDir, 'tasks', 'tasks.json'));
    this.scheduler = new TaskScheduler({
      store: this.store,
      runsDir: path.join(opts.dataDir, 'tasks', 'runs'),
      locksDir: path.join(opts.dataDir, 'tasks', 'locks'),
      worktreesDir: path.join(opts.dataDir, 'tasks', 'worktrees'),
      providers: () => opts.providers,
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
  }

  /** 启动周期 tick（每分钟检查到期任务）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.tickMs ?? 60_000);
    // 立即跑一次：错过补跑策略生效（catch-up-once）。
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 单次 tick（测试 / 手动触发）。 */
  async tick(): Promise<{ triggered: string[]; errors: string[] }> {
    const r = await this.scheduler.tick();
    if (r.triggered.length > 0 || r.errors.length > 0) this.opts.onTaskEvent?.();
    return { triggered: r.triggered, errors: r.errors };
  }

  /** 全部任务（渲染端视图）。 */
  list(): ScheduleTaskView[] {
    const now = this.opts.clock?.() ?? new Date();
    return this.store.load().map((t) => this.toView(t, now));
  }

  /**
   * 新建定时任务。
   * @param spec 名称 / cron / 提示词 / 工作区 / 产物策略等
   */
  create(spec: {
    name: string;
    cron: string;
    prompt: string;
    workspace: string;
    model?: string;
    artifact?: 'report-only' | 'branch' | 'pr' | 'direct';
    policyMode?: 'readonly' | 'allowlist' | 'full';
    notify?: boolean;
  }): { ok: boolean; task?: ScheduleTaskView; error?: string } {
    const name = spec.name.trim();
    if (!name) return { ok: false, error: '任务名称不能为空' };
    if (!spec.prompt.trim()) return { ok: false, error: '任务指令不能为空' };
    if (!spec.workspace.trim()) return { ok: false, error: '请选择目标工作区（项目文件夹）' };
    // cron 校验：nextRunAt 解析失败会抛错（5 字段标准 cron）。
    const schedule: Schedule = { kind: 'cron', expression: spec.cron.trim() };
    let next: Date;
    try {
      next = nextRunAt(schedule, this.opts.clock?.() ?? new Date());
    } catch (e) {
      return {
        ok: false,
        error: `cron 表达式无效（需 5 字段：分 时 日 月 周）：${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const now = new Date().toISOString();
    const task: TaskSpec = {
      id: newTaskId(),
      name,
      prompt: spec.prompt.trim(),
      workspace: spec.workspace.trim(),
      schedule,
      config: {
        ...(spec.model ? { model: spec.model } : {}),
        policy: { mode: spec.policyMode ?? 'readonly' },
        artifact: spec.artifact ?? 'report-only',
      },
      ...(spec.notify ? { notifications: { on: ['completed', 'failed'], desktop: true } } : {}),
      enabled: true,
      createdAt: now,
      state: {
        consecutiveFailures: 0,
        totalRuns: 0,
        nextRunAt: next.toISOString(),
      },
    };
    try {
      this.store.add(task);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.opts.onTaskEvent?.();
    return { ok: true, task: this.toView(task, this.opts.clock?.() ?? new Date()) };
  }

  /** 启停切换。 */
  toggle(id: string): { ok: boolean; task?: ScheduleTaskView; error?: string } {
    const t = this.store.get(id);
    if (!t) return { ok: false, error: `任务不存在: ${id}` };
    const updated = this.store.setEnabled(id, !t.enabled);
    this.opts.onTaskEvent?.();
    return updated ? { ok: true, task: this.toView(updated, new Date()) } : { ok: false };
  }

  /** 删除任务。 */
  remove(id: string): { ok: boolean; error?: string } {
    const ok = this.store.remove(id);
    if (!ok) return { ok: false, error: `任务不存在: ${id}` };
    this.opts.onTaskEvent?.();
    return { ok: true };
  }

  /** 立即运行（不等待 cron 到期；trigger=manual，与定时触发同一执行链路）。 */
  async runNow(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running.has(id)) return { ok: false, error: '任务正在运行中' };
    const t = this.store.get(id);
    if (!t) return { ok: false, error: `任务不存在: ${id}` };
    this.running.add(id);
    this.opts.onTaskEvent?.();
    try {
      await this.scheduler.runNow(id);
      this.opts.onTaskEvent?.();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running.delete(id);
      this.opts.onTaskEvent?.();
    }
  }

  /** 是否运行中（渲染端可显示进行时状态）。 */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  private toView(t: TaskSpec, now: Date): ScheduleTaskView {
    const last = t.state.lastStatus;
    return {
      id: t.id,
      name: t.name,
      cron: t.schedule.kind === 'cron' ? t.schedule.expression : String(t.schedule.kind),
      nextRun: t.state.nextRunAt ?? nextRunAt(t.schedule, now).toISOString(),
      enabled: t.enabled,
      lastStatus:
        last === 'success' || last === 'failed' || last === 'skipped-overlap' || last === 'timeout'
          ? last
          : 'never',
      prompt: t.prompt,
      workspace: t.workspace,
    };
  }
}
