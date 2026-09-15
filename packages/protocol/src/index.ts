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
  /**
   * workspace 目录。可省略：新建任务不再强制先选文件夹，
   * 缺省回退（用户主目录 / 上次选择），之后经 `session:setWorkspace` 随时切换。
   */
  workspaceRoot?: string;
  /** 可选初始配置覆盖。 */
  config?: Partial<SessionConfig>;
}

/** 更换会话的项目文件夹（输入栏「+」→ 选择项目文件夹）。 */
export interface SessionSetWorkspaceRequest {
  sessionId: string;
  /** 新的 workspace 绝对路径（原生目录选择框返回）。 */
  workspaceRoot: string;
}

export interface SessionSetWorkspaceResponse {
  ok: boolean;
  summary?: SessionSummary;
  error?: string;
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

/**
 * 上游 API 格式（provider 接入的协议形态）。
 * - openai: OpenAI Chat Completions（baseUrl 含版本段，如 https://api.deepseek.com/v1）
 * - openai-responses: OpenAI Responses API（baseUrl 不含版本段）
 * - anthropic: Anthropic Messages（baseUrl 不含版本段）
 * - gemini: Gemini generateContent（baseUrl 不含版本段）
 */
export type ApiFormat = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

export interface ProviderSummary {
  id: string;
  model: string;
  baseUrl?: string;
  /** 上游 API 格式（默认 openai）。 */
  apiFormat?: ApiFormat;
  /**
   * 该提供商提供的全部可选模型（任务窗口模型选择器的数据源）。
   * 优先级：models 列表 > modelMap 本地名 > [model]；空列表 + 无 model = 自动路由。
   */
  models?: string[];
  /** 模型映射原文（本地模型名 → 上游模型名；旧数据兼容）。 */
  modelMap?: Record<string, string>;
  /** 自动路由（model 为空，由网关如 FreeLLMAPI 自行选择模型）。 */
  autoRoute?: boolean;
  /** 是否已配置密钥（布尔，不回传明文）。 */
  hasApiKey: boolean;
  /** 脱敏后的密钥预览（如 `sk-…3f9a`）。 */
  maskedKey?: string;
}

export interface ConfigSetRequest {
  patch: Record<string, unknown>;
}

export interface ProviderAddRequest {
  id: string;
  model: string;
  /** 该提供商接入的模型列表（多模型；空 = 网关自动路由）。 */
  models?: string[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  /** 上游 API 格式（默认 openai）。 */
  apiFormat?: ApiFormat;
  /** 模型映射（本地模型名 → 上游模型名）；旧数据兼容，有此字段即视为映射接入。 */
  modelMap?: Record<string, string>;
}

export interface ProviderRemoveRequest {
  id: string;
}

export interface ProviderUpdateRequest {
  id: string;
  model?: string;
  /** 该提供商接入的模型列表（多模型；整体替换）。 */
  models?: string[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  /** 上游 API 格式。 */
  apiFormat?: ApiFormat;
  /** 模型映射（本地模型名 → 上游模型名）；整体替换。 */
  modelMap?: Record<string, string>;
}

export interface ProviderTestRequest {
  providerId: string;
}
export interface ProviderTestResponse {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** 拉取 provider 端点下全部可用模型（§10.5④ 模型下拉）。 */
export interface ProviderModelsRequest {
  providerId: string;
  /** 临时覆盖（表单尚未保存时使用）；不传则用已保存的 baseUrl / API Key。 */
  baseUrl?: string;
  apiKey?: string;
  /** 上游 API 格式（决定 /models 端点路径形态；默认 openai）。 */
  apiFormat?: ApiFormat;
}
export interface ProviderModelsResponse {
  ok: boolean;
  /** 端点返回的模型 id 列表（已排序去重）。 */
  models?: string[];
  error?: string;
}

/** 探测本地 OpenAI 兼容服务（FreeLLMAPI 等）。 */
export interface ProviderDiscoverRequest {
  /** 候选端口（默认常用本地端口，可覆盖）。 */
  ports?: number[];
}
export interface ProviderDiscoverResponse {
  ok: boolean;
  /** 发现的 OpenAI 兼容 base URL（如 http://127.0.0.1:3000/v1）。 */
  baseUrl?: string;
  port?: number;
  error?: string;
}

// ── 定时任务（M4.5 / M13；SchedulePanel 数据源）───────────────────

/** 渲染端可见的定时任务视图。 */
export interface ScheduleTaskInfo {
  id: string;
  name: string;
  /** 5 字段 cron 表达式（展示用）。 */
  cron: string;
  /** 下次执行（ISO 时间）。 */
  nextRun: string;
  enabled: boolean;
  lastStatus: 'success' | 'failed' | 'pending' | 'never' | 'skipped-overlap' | 'timeout';
  /** 任务指令。 */
  prompt?: string;
  /** 目标工作区绝对路径。 */
  workspace?: string;
}

/** 新建定时任务请求（schedule:create）。 */
export interface ScheduleCreateRequest {
  name: string;
  /** 5 字段标准 cron（分 时 日 月 周）。 */
  cron: string;
  /** 任务指令（无人值守，必须自包含）。 */
  prompt: string;
  /** 目标工作区绝对路径。 */
  workspace: string;
  /** 覆盖执行模型（可选）。 */
  model?: string;
  /** 产物策略（默认 report-only）。 */
  artifact?: 'report-only' | 'branch' | 'pr' | 'direct';
  /** 无人值守策略（默认 readonly）。 */
  policyMode?: 'readonly' | 'allowlist' | 'full';
  /** 完成后系统通知。 */
  notify?: boolean;
}

export interface ScheduleCreateResponse {
  ok: boolean;
  task?: ScheduleTaskInfo;
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
  /**
   * http/sse 附加请求头（如 `Authorization: Bearer xxx`）。
   * 直连 transport 层的 HttpServerConfig.headers。
   */
  headers?: Record<string, string>;
  /** 鉴权：bearer 时从环境变量读 token（与 headers 二选一或并用）。 */
  auth?: { mode: 'none' | 'bearer' | 'oauth'; bearerEnv?: string };
  /** 握手超时 ms（默认 30000）。 */
  timeoutMs?: number;
  /** stdio 工作目录。 */
  cwd?: string;
}

/** mcp.json 配置文件内容（直接编辑用，§10.5⑦）。 */
export interface McpGetConfigResponse {
  ok: boolean;
  /** 完整配置数组（即持久化的 mcpServers）。 */
  servers?: McpAddRequest[];
  error?: string;
}

export interface McpSetConfigRequest {
  /** 整体替换配置；先校验再落盘，失败时不动原配置。 */
  servers: McpAddRequest[];
}

export interface McpSetConfigResponse {
  ok: boolean;
  /** 校验失败的逐条错误（index → 原因）。 */
  errors?: Array<{ index: number; error: string }>;
  error?: string;
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

/** 选择本地文件夹作为任务 workspace（原生目录选择框，§10.5①）。 */
export interface WorkspacePickResponse {
  ok: boolean;
  /** 选中的目录绝对路径；用户取消时为空。 */
  path?: string;
  /** 用户主动取消（此时不应创建会话）。 */
  canceled?: boolean;
  error?: string;
}

// ── @ 引用文件/文件夹（输入框 mention 弹层）───────────────────────

/** workspace 内的一个条目（文件或文件夹）。 */
export interface WorkspaceEntry {
  /** 条目名（不含路径）。 */
  name: string;
  /** 相对 workspace 的路径（统一 `/` 分隔）。 */
  path: string;
  isDir: boolean;
}

export interface WorkspaceListEntriesRequest {
  sessionId: string;
  /** 相对 workspace 的子目录（缺省为根目录）。 */
  dir?: string;
  /** 非空时递归搜索文件/文件夹名（@xxx 全局搜索模式）。 */
  query?: string;
}

export interface WorkspaceListEntriesResponse {
  ok: boolean;
  entries: WorkspaceEntry[];
  /** 当前 workspace 绝对路径（渲染端拼接 @ 引用的绝对路径用）。 */
  workspaceRoot?: string;
  error?: string;
}

// ── 技能（+ 菜单勾选 / SkillPanel 展示）───────────────────────────

/** 技能元信息（主进程扫描 ~/.mozi/skills 与 workspace/.mozi/skills）。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: 'builtin' | 'custom' | 'project';
  /** 技能来源路径（custom/project 有值）。 */
  source?: string;
  icon?: string;
  version?: string;
  triggers?: string[];
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
  'session:setWorkspace': (req: SessionSetWorkspaceRequest) => SessionSetWorkspaceResponse;
  'run:start': (req: RunStartRequest) => RunStartResponse;
  'approval:resolve': (req: ApprovalResolveRequest) => { ok: boolean };
  'engine:abort': (req: EngineAbortRequest) => { ok: boolean };
  'config:get': () => ConfigGetResponse;
  'config:set': (req: ConfigSetRequest) => { ok: boolean };
  'config:listProviders': () => ProviderSummary[];
  'config:testProvider': (req: ProviderTestRequest) => ProviderTestResponse;
  'provider:models': (req: ProviderModelsRequest) => ProviderModelsResponse;
  'provider:discoverLocal': (req: ProviderDiscoverRequest) => ProviderDiscoverResponse;
  'provider:add': (req: ProviderAddRequest) => { ok: boolean; error?: string };
  'provider:remove': (req: ProviderRemoveRequest) => { ok: boolean };
  'provider:update': (req: ProviderUpdateRequest) => { ok: boolean; error?: string };
  'mcp:list': () => McpServerInfo[];
  'mcp:add': (req: McpAddRequest) => { ok: boolean; error?: string };
  'mcp:remove': (req: { id: string }) => { ok: boolean };
  'mcp:restart': (req: { id: string }) => { ok: boolean };
  'mcp:getConfig': () => McpGetConfigResponse;
  'mcp:setConfig': (req: McpSetConfigRequest) => McpSetConfigResponse;
  'audit:query': (req: AuditQueryRequest) => AuditEntry[];
  'dashboard:stats': () => DashboardStats;
  'diff:applyPartial': (req: PartialApplyRequest) => { ok: boolean; applied: number };
  'browser:capture': () =>
    | { contentId: string; base64: string; width: number; height: number }
    | { error: string };
  'browser:saveAnnotated': (req: { base64: string; sessionId?: string }) => {
    ok: boolean;
    contentId: string;
  };
  'browser:attach': (req: { sessionId: string; webContentsId: number }) => {
    ok: boolean;
    error?: string;
  };
  'browser:detach': (req: { sessionId: string }) => { ok: boolean };
  /** 读取本地图片为 base64（会话内截图卡片放大查看；主进程做扩展名/大小白名单校验）。 */
  'image:read': (req: { path: string }) => {
    ok: boolean;
    base64?: string;
    mime?: string;
    error?: string;
  };
  'workspace:pick': () => WorkspacePickResponse;
  'workspace:listEntries': (req: WorkspaceListEntriesRequest) => WorkspaceListEntriesResponse;
  'skills:list': (req: { sessionId?: string }) => SkillSummary[];
  // 定时任务（M4.5 / M13）：SchedulePanel 真实数据源
  'schedule:list': () => ScheduleTaskInfo[];
  'schedule:create': (req: ScheduleCreateRequest) => ScheduleCreateResponse;
  'schedule:toggle': (req: { id: string }) => {
    ok: boolean;
    task?: ScheduleTaskInfo;
    error?: string;
  };
  'schedule:delete': (req: { id: string }) => { ok: boolean; error?: string };
  'schedule:runNow': (req: { id: string }) => { ok: boolean; error?: string };
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
  /** 定时任务状态变化（TaskSchedulerHost.onTaskEvent → 渲染端重取 schedule:list）。 */
  'schedule:changed': Record<string, never>;
};

export type SendChannel = keyof SendChannelMap;

/** 全部通道名（诊断 / 契约一致性测试用）。 */
export const INVOKE_CHANNELS: InvokeChannel[] = [
  'session:create',
  'session:resume',
  'session:fork',
  'session:list',
  'session:delete',
  'session:setWorkspace',
  'run:start',
  'approval:resolve',
  'engine:abort',
  'config:get',
  'config:set',
  'config:listProviders',
  'config:testProvider',
  'provider:add',
  'provider:remove',
  'provider:update',
  'provider:models',
  'provider:discoverLocal',
  'mcp:list',
  'mcp:add',
  'mcp:remove',
  'mcp:restart',
  'mcp:getConfig',
  'mcp:setConfig',
  'audit:query',
  'dashboard:stats',
  'diff:applyPartial',
  'browser:capture',
  'browser:saveAnnotated',
  'browser:attach',
  'browser:detach',
  'image:read',
  'workspace:pick',
  'workspace:listEntries',
  'skills:list',
  'schedule:list',
  'schedule:create',
  'schedule:toggle',
  'schedule:delete',
  'schedule:runNow',
];

export const SEND_CHANNELS: SendChannel[] = [
  'engine:event',
  'session:status',
  'updater:status',
  'updater:download-progress',
  'schedule:changed',
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
export * from './remote.js';
export * from './crypto-box.js';
export * from './remote-node.js';
