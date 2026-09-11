import type { TokenUsage, ToolCall } from './messages.js';
/**
 * 会话配置与引擎输入/快照契约（M1 §1.4 / §1.8）。
 */
import type { ApprovalReason, PolicyConfig } from './policy-types.js';

export interface SessionLimits {
  maxSteps: number; // 默认 50
  maxTokensPerTurn: number; // 默认 32k
  maxOutputTokens: number; // 默认 4k
  idleTimeoutMs: number; // 默认 300_000
  toolTimeoutMs: number; // 默认 120_000
  maxCost?: number; // 会话累计成本上限（可选）
}

export interface SessionConfig {
  models: { planner?: string; executor: string };
  policy: PolicyConfig;
  sandbox: { level: 0 | 1 | 2 | 3 };
  context: { maxTokens?: number; autoCompactThreshold?: number };
  enabledTools: string[]; // '*' 或白名单
  limits?: Partial<SessionLimits>;
}

export interface RunInput {
  sessionId: string;
  text: string;
  overrides?: Partial<SessionConfig>;
  signal?: AbortSignal;
  /** 由 Supervisor 注入的既有会话（子 Agent 复用内存态，避免重复 loadOrCreate）。 */
  session?: unknown;
}

export type EngineState =
  | 'idle'
  | 'thinking'
  | 'pending_approval'
  | 'executing'
  | 'waiting_compact'
  | 'completed'
  | 'interrupted'
  | 'failed';

export interface ApprovalTicket {
  callId: string;
  call: ToolCall;
  reason: ApprovalReason;
}

export interface SessionSnapshot {
  sessionId: string;
  state: EngineState;
  currentStep: number;
  lastToolCalls: ToolCall[];
  pendingApprovals: ApprovalTicket[];
  usage: TokenUsage;
  startedAt: string;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxSteps: 50,
  maxTokensPerTurn: 32_000,
  maxOutputTokens: 4_000,
  idleTimeoutMs: 300_000,
  toolTimeoutMs: 120_000,
};

export function defaultConfig(executor = 'deepseek-chat'): SessionConfig {
  return {
    models: { executor },
    policy: { mode: 'auto', rules: [] },
    sandbox: { level: 1 },
    context: { maxTokens: 128_000, autoCompactThreshold: 0.8 },
    enabledTools: ['*'],
    limits: {},
  };
}
