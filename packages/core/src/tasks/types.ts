/**
 * M4.5 / M13 定时任务契约（packages/core/src/tasks/types.ts）。
 * 无人值守任务 = 调度（何时跑）+ 隔离（在哪跑）+ 安全（能做什么）+ 产物 + 通知。
 */

/** 任务调度方式（13.3） */
export type Schedule =
  | { kind: 'cron'; expression: string; timeZone?: string } // 5 字段标准 cron，默认系统时区
  | { kind: 'interval'; everyMinutes: number } // 固定间隔，>= 10
  | { kind: 'once'; at: string }; // ISO8601 绝对时刻，跑完自动 disable

/** 无人值守策略（13.5）：与交互式 PolicyConfig 不同，无 'ask' 概念 */
export interface UnattendedPolicy {
  mode: 'readonly' | 'allowlist' | 'full';
  /** allowlist 模式：白名单外的 shell / 写操作直接 deny（模型可自纠走安全路径） */
  allowlist?: {
    commands?: string[]; // shell 命令前缀白名单：['npm test', 'npm run build', 'git status']
    writePathGlobs?: string[]; // 可写路径 glob：['src/**', 'test/**']
  };
  /** ask 处置策略：deny 静态化（默认）或升级移动端审批（v1.4 预留） */
  askEscalation?: 'deny' | 'mobile';
}

/** 任务产物策略（13.6） */
export type ArtifactKind = 'report-only' | 'branch' | 'pr' | 'direct';

export interface TaskRunConfig {
  model?: string; // 覆盖 executor
  agentTemplate?: string; // 复用 M12 模板（reviewer/explore/自定义）作为 headless 人格
  policy: UnattendedPolicy;
  sandboxLevel?: 0 | 1 | 2 | 3; // 默认 2；full 模式必须 >= 3（不变式 I4）
  artifact: ArtifactKind;
  maxSteps?: number; // 默认 30（无人值守收紧）
  maxCostUsd?: number; // 单次成本上限（默认 $1.0，I5）
  timeoutMs?: number; // 默认 30 分钟
  env?: Record<string, string>;
}

export interface NotificationConfig {
  on: Array<'completed' | 'failed'>;
  desktop?: boolean;
  webhook?: string;
  includeReport?: boolean; // 默认 true（摘要 1k 字符）
}

export interface TaskState {
  lastRunAt?: string;
  lastRunId?: string;
  nextRunAt?: string;
  lastStatus?: 'success' | 'failed' | 'skipped-overlap' | 'skipped-cooldown' | 'timeout';
  consecutiveFailures: number;
  totalRuns: number;
  missedRuns?: number;
}

export interface TaskSpec {
  id: string; // 'task-<rand8>'（用户可改名）
  name: string;
  prompt: string; // 任务指令（无人值守 → 必须自包含）
  workspace: string; // 目标仓库绝对路径
  schedule: Schedule;
  config: TaskRunConfig;
  notifications?: NotificationConfig;
  enabled: boolean;
  createdAt: string;
  state: TaskState;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  status: 'success' | 'failed' | 'timeout' | 'skipped-overlap';
  startedAt: string;
  endedAt: string;
  trigger: 'schedule' | 'manual';
  missedRuns?: number;
  error?: { code: string; message: string };
  steps?: number;
  toolCalls?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
  artifacts?: {
    branch?: string;
    prUrl?: string;
    changedFiles?: string[];
    patchFile?: string;
    reportFile?: string;
  };
  summary?: string;
}

/** 错过补跑策略（13.4） */
export type MissedPolicy = 'skip' | 'catch-up-once' | 'catch-up-all';

export interface TaskOptions {
  storeFile: string; // tasks.json 路径
  runsDir?: string; // 运行记录根
  locksDir?: string; // 锁目录
  worktreesDir?: string; // worktree 根
  missedPolicy?: MissedPolicy;
  clock?: () => Date;
}

export const DEFAULT_TASK_OPTIONS = {
  missedPolicy: 'catch-up-once' as MissedPolicy,
  maxSteps: 30,
  maxCostUsd: 1.0,
  timeoutMs: 1_800_000,
  sandboxLevel: 2,
  minIntervalMinutes: 10,
};

/** 无人值守默认系统提示（13.6 ②） */
export const UNATTENDED_SYSTEM_PROMPT =
  '你是无人值守定时任务执行者。用户不在场：不可请求确认；被拒绝的操作请改用安全替代方案或记录到报告；结束时输出结构化报告（结论 / 改动清单 / 遗留问题）。';