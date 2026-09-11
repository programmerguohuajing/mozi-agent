/**
 * 调度求解（M4.5 / M13 §13.4）：cron / interval / once 三种调度的 nextRun 统一求解，
 * 以及「关机错过 N 次触发」的补跑策略（skip / catch-up-once / catch-up-all）。
 */
import { parseCron, nextRunAfter } from './cron.js';
import type { Schedule, TaskSpec } from './types.js';
import { DEFAULT_TASK_OPTIONS } from './types.js';

/** 计算任务下一次应运行时刻（严格晚于 from）。once 过期时返回 from（立即触发一次）。 */
export function nextRunAt(schedule: Schedule, from: Date): Date {
  switch (schedule.kind) {
    case 'cron':
      return nextRunAfter(from, parseCron(schedule.expression), schedule.timeZone);
    case 'interval': {
      const n = Math.max(DEFAULT_TASK_OPTIONS.minIntervalMinutes, schedule.everyMinutes);
      // 对齐到整分钟：ceil(from) + n 分钟
      const base = Math.ceil(from.getTime() / 60_000) * 60_000;
      return new Date(base + n * 60_000);
    }
    case 'once': {
      const at = new Date(schedule.at);
      return at > from ? at : from;
    }
  }
}

/**
 * 估算错过次数：从 nextRunAt 之后按「上一次周期」推断错过的周期数。
 * period = nextRunAt - lastRunAt（相邻触发间隔）。
 */
export function countMissedRuns(spec: TaskSpec, now: Date): number {
  const next = spec.state.nextRunAt ? new Date(spec.state.nextRunAt) : null;
  const last = spec.state.lastRunAt ? new Date(spec.state.lastRunAt) : null;
  if (!next || !last || next.getTime() >= now.getTime()) return 0;
  const period = next.getTime() - last.getTime();
  if (period <= 0) return 0;
  return Math.max(0, Math.floor((now.getTime() - next.getTime()) / period));
}

/**
 * 推进任务状态：按补跑策略决定本轮是否补跑，并计算新的 nextRunAt。
 * @returns { missed, shouldRun, nextAt } —— shouldRun=true 表示本轮应执行一次
 */
export function planTick(spec: TaskSpec, now: Date, missedPolicy = DEFAULT_TASK_OPTIONS.missedPolicy) {
  const s = spec.state;
  // 首次调度：无 nextRunAt → 求解首个触发时刻
  if (s.nextRunAt === undefined) {
    // 一次性任务已过期 → 立即触发一次（13.4：once 错过 → 立即补跑后 disable）
    if (spec.schedule.kind === 'once' && new Date(spec.schedule.at).getTime() <= now.getTime()) {
      const nextAt = nextRunAt(spec.schedule, now);
      return { missed: 1, shouldRun: true, nextAt, note: 'once-due' };
    }
    const nextAt = nextRunAt(spec.schedule, now);
    return { missed: 0, shouldRun: false, nextAt, note: 'scheduled-first' };
  }
  const next = new Date(s.nextRunAt);
  if (next.getTime() > now.getTime()) {
    return { missed: 0, shouldRun: false, nextAt: next, nextDate: next, note: 'not-due' };
  }

  const missed = countMissedRuns(spec, now);
  let shouldRun: boolean;
  let note: string;
  if (missed > 0) {
    // 错过多期：按策略处置
    if (missedPolicy === 'skip') {
      shouldRun = false;
      note = `missed-skip (${missed})`;
    } else if (missedPolicy === 'catch-up-all') {
      shouldRun = true;
      note = `catch-up-all (${missed})`;
    } else {
      // catch-up-once（默认）：补跑一次最新状态
      shouldRun = true;
      note = `catch-up-once (${missed})`;
    }
  } else {
    shouldRun = true;
    note = 'due';
  }

  // 推进：基于 now 计算下一次（先推进防执行中崩溃导致重复触发）
  const nextAt = nextRunAt(spec.schedule, now);
  return { missed, shouldRun, nextAt, note };
}