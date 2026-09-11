/**
 * 统一通道语义（详细设计 §10.3 / §14.3）。
 *
 * 设计原则（§14 原则 3）：**移动端协议 = 桌面 IPC 协议**，零分叉。
 * 本文件定义与传输无关的 channel 清单与请求/应答 DTO；三种适配器复用同一套语义：
 *   - Electron IPC（桌面）
 *   - 进程内直连（TUI / 测试）
 *   - WebSocket（远程 / 移动端）
 */
import type {
  AgentEvent,
  ApprovalReason,
  PolicyMode,
  SessionConfig,
  TokenUsage,
  ToolCall,
} from '@mozi/shared';

/** 会话在宿主侧的运行状态（`session:status` 推送）。 */
export type SessionState = 'idle' | 'running' | 'pending_approval' | 'completed' | 'failed';

// ── invoke 请求（Renderer → Main，请求 / 应答）─────────────────────

/** 会话摘要（侧栏列表项，§10.5①）。 */
export interface SessionSummary {
  id: string;
  workspace?: string;
  model?: string;
  updatedAt?: string;
  state: SessionState;
  usage?: TokenUsage;
  /** 项目名（取 workspace 末段，侧栏展示用）。 */
  project?: string;
  /** 父会话 id（子会话树，§10.5⑥）。 */
  parentSessionId?: string;
  /** 子智能体模板类型。 */
  agentType?: string;
}

export interface SessionCreateRequest {
  /** 省略则由主进程生成。 */
  sessionId?: string;
  /** workspace 目录（来自文件对话框）。 */
  workspaceRoot: string;
  /** 可选初始配置覆盖。 */
  config?: Partial<SessionConfig>;
}

export interface RunStartRequest {
  sessionId: string;
  text: string;
  /** 每轮可覆盖策略模式等。 */
  overrides?: Partial<SessionConfig>;
}

export interface RunStartResponse {
  /** 立即返回；任务在后台推进，事件经 `engine:event` 推送。 */
  runId: string;
  accepted: boolean;
  /** 被拒绝时的原因（如 ERR_SESSION_BUSY）。 */
  error?: { code: string; message: string };
}

export interface ApprovalResolveRequest {
  sessionId: string;
  callId: string;
  decision: 'allow' | 'deny';
  /** 「本次会话一律允许」——写回会话级策略规则。 */
  onceForSession?: boolean;
}

export interface EngineAbortRequest {
  sessionId: string;
  reason?: string;
}

export interface ConfigGetResponse {
  settings: Record<string, unknown>;
  /** 已脱敏的 provider 列表（密钥绝不出主进程，§10.6）。 */
  providers: ProviderSummary[];
  policyMode: PolicyMode;
}

export interface ProviderSummary {
  id: string;
  model: string;
  baseUrl?: string;
  /** 是否已配置密钥（布尔，不回传明文）。 */
  hasApiKey: boolean;
  /** 脱敏后的密钥预览（如 `sk-…3f9a`）。 */
  maskedKey?: string;
}

export interface ConfigSetRequest {
  patch: Record<string, unknown>;
}

export interface ProviderTestRequest {
  providerId: string;
}
export interface ProviderTestResponse {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface McpServerInfo {
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'offline';
  toolCount: number;
  latencyMs?: number;
  /** 采样三档开关（§10.5⑦）。 */
  sampling?: 'deny' | 'ask' | 'allow';
  trusted?: boolean;
}

export interface McpAddRequest {
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface AuditQueryRequest {
  since?: string;
  until?: string;
  filters?: { sessionId?: string; tool?: string; decision?: 'allow' | 'deny' };
}
export interface AuditEntry {
  ts: string;
  sessionId: string;
  tool: string;
  callId: string;
  decision: 'allow' | 'deny';
  by: 'user' | 'policy';
  summary?: string;
}

/** 仪表盘聚合（§10.5⑤）。 */
export interface DashboardStats {
  tokensByDay: Array<{ date: string; input: number; output: number }>;
  toolCalls: Array<{ name: string; count: number }>;
  approvals: { allow: number; deny: number };
  costByModel: Array<{ model: string; costUsd: number }>;
}

/** 被批准的 hunk 选择（§10.5③ 逐 hunk 批准）。 */
export interface PartialApplyRequest {
  sessionId: string;
  file: string;
  hunkIds: string[];
}

// ── channel 清单（§10.3）──────────────────────────────────────────

/** invoke handler 返回值允许同步或异步（传输层统一 await）。 */
export type MaybePromise<T> = T | Promise<T>;

/** invoke：请求 / 应答式通道。 */
export interface InvokeChannels {
  'session:create': (req: SessionCreateRequest) => SessionSummary;
  'session:resume': (req: { sessionId: string }) => SessionSummary | null;
  'session:fork': (req: { sessionId: string; atEventIndex?: number }) => SessionSummary;
  'session:list': () => SessionSummary[];
  'session:delete': (req: { sessionId: string }) => { ok: boolean };
  'run:start': (req: RunStartRequest) => RunStartResponse;
  'approval:resolve': (req: ApprovalResolveRequest) => { ok: boolean };
  'engine:abort': (req: EngineAbortRequest) => { ok: boolean };
  'config:get': () => ConfigGetResponse;
  'config:set': (req: ConfigSetRequest) => { ok: boolean };
  'config:listProviders': () => ProviderSummary[];
  'config:testProvider': (req: ProviderTestRequest) => ProviderTestResponse;
  'mcp:list': () => McpServerInfo[];
  'mcp:add': (req: McpAddRequest) => { ok: boolean; error?: string };
  'mcp:remove': (req: { id: string }) => { ok: boolean };
  'mcp:restart': (req: { id: string }) => { ok: boolean };
  'audit:query': (req: AuditQueryRequest) => AuditEntry[];
  'dashboard:stats': () => DashboardStats;
  'diff:applyPartial': (req: PartialApplyRequest) => { ok: boolean; applied: number };
}

export type InvokeChannel = keyof InvokeChannels;

// ── send（Main → Renderer，事件推送）──────────────────────────────

export type SendChannelMap = {
  'engine:event': { sessionId: string; event: AgentEvent };
  'session:status': { sessionId: string; state: SessionState; usage?: TokenUsage };
  'updater:status': {
    state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
    version?: string;
    error?: string;
  };
  'updater:download-progress': { percent: number; bytesPerSecond?: number };
};

export type SendChannel = keyof SendChannelMap;

/** 全部通道名（诊断 / 契约一致性测试用）。 */
export const INVOKE_CHANNELS: InvokeChannel[] = [
  'session:create',
  'session:resume',
  'session:fork',
  'session:list',
  'session:delete',
  'run:start',
  'approval:resolve',
  'engine:abort',
  'config:get',
  'config:set',
  'config:listProviders',
  'config:testProvider',
  'mcp:list',
  'mcp:add',
  'mcp:remove',
  'mcp:restart',
  'audit:query',
  'dashboard:stats',
  'diff:applyPartial',
];

export const SEND_CHANNELS: SendChannel[] = [
  'engine:event',
  'session:status',
  'updater:status',
  'updater:download-progress',
];

// ── 传输适配器契约（三种传输同一语义，§14.3）──────────────────────

/** 主进程侧：注册 handler + 向渲染侧推送。 */
export interface ChannelServer {
  /** 注册一个 invoke handler；调用方保证同名通道只注册一次。 */
  handle<C extends InvokeChannel>(
    channel: C,
    handler: (
      payload: Parameters<InvokeChannels[C]>[0],
    ) => MaybePromise<ReturnType<InvokeChannels[C]>>,
  ): void;
  /** 向指定接收方（窗口 / 连接）推送 send 事件。 */
  send<C extends SendChannel>(channel: C, payload: SendChannelMap[C]): void;
}

/** 渲染侧：发起 invoke + 订阅 send。 */
export interface ChannelClient {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload: Parameters<InvokeChannels[C]>[0],
  ): Promise<Awaited<ReturnType<InvokeChannels[C]>>>;
  on<C extends SendChannel>(channel: C, listener: (payload: SendChannelMap[C]) => void): () => void;
}

/**
 * 审批事件辅助：从 AgentEvent 中提取需要冒泡到 UI 的审批票据（父 / 子统一）。
 * §12.7 子智能体审批冒泡复用普通审批组件，仅多一个 agentType 徽标。
 */
export interface ApprovalTicketView {
  callId: string;
  sessionId: string;
  call: ToolCall;
  reason: ApprovalReason;
  /** 非空表示来自子智能体（审批卡显示 [子智能体 type] 徽标）。 */
  agentType?: string;
  subSessionId?: string;
}

export function approvalTicketFromEvent(
  sessionId: string,
  event: AgentEvent,
): ApprovalTicketView | null {
  if (event.type === 'tool.approval.required') {
    return { callId: event.call.id, sessionId, call: event.call, reason: event.reason };
  }
  if (event.type === 'subagent.approval.required') {
    return {
      callId: event.callId,
      sessionId,
      call: event.call,
      reason: event.reason,
      agentType: event.agentType,
      subSessionId: event.subSessionId,
    };
  }
  return null;
}

export { LoopbackChannel } from './loopback.js';
