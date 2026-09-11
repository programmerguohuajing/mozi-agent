/**
 * M18 Hooks 与生命周期插件（§18.2/§18.3）。
 *
 * 与既有扩展机制正交：MCP = 增加能力（工具）；子智能体 = 委派任务；
 * Hooks = 在既有动作前后插入用户逻辑（不改变动作本身）。
 */

/** 14 个钩子点（§18.2）。 */
export const HOOK_EVENTS = [
  'session:start',
  'session:end',
  'turn:start',
  'turn:end',
  'tool:pre',
  'tool:post',
  'approval:pre',
  'approval:post',
  'compact:pre',
  'compact:post',
  'task:run:pre',
  'task:run:post',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 退出码语义（§18.4）：0 continue / 2 block / 其他按 onExit 映射（默认 ask）。 */
export type HookAction = 'continue' | 'block' | 'ask';

/** 匹配器：全部为可选，命中全部条件才触发。 */
export interface HookMatch {
  /** 精确工具名。 */
  tool?: string;
  /** shell 命令正则（tool:pre/post 且 tool=shell）。 */
  commandPattern?: string;
  /** 文件路径 glob（tool:pre/post 的写操作）。 */
  pathGlob?: string;
  /** 会话 id 或模板类型过滤（可选）。 */
  agentType?: string;
}

export interface HookSpec {
  event: HookEvent;
  match?: HookMatch;
  /** 进程执行命令（shell 形式，stdin 收 JSON 载荷）。 */
  run: string;
  /** 超时（默认 5000ms，上限 60000ms）。 */
  timeoutMs?: number;
  /** 退出码 → 动作映射；'*' 为兜底（默认 continue）。 */
  onExit?: Record<string, HookAction>;
}

export interface HooksFile {
  hooks: HookSpec[];
}

/** hook 来源（决定防投毒策略）。 */
export type HookOrigin = 'user' | 'project';

export interface ResolvedHook extends HookSpec {
  origin: HookOrigin;
  /** 配置文件的绝对路径。 */
  source: string;
  /** 该 hook 在文件中的索引（用于稳定 id）。 */
  index: number;
}

/** hook 执行结果。 */
export interface HookOutcome {
  hook: ResolvedHook;
  action: HookAction;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 是否超时（超时按 onExit['*'] 处理 + 告警事件）。 */
  timedOut: boolean;
  /** 进程崩溃/命令不存在。 */
  failed: boolean;
  /** stdout 中的 {"note": "..."} 注入下轮上下文。 */
  note?: string;
}

/** 默认超时与上限（§18.4）。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
/** stdout/stderr 各截断字节数（§18.4：各截 4KB）。 */
export const HOOK_OUTPUT_LIMIT = 4 * 1024;
/** 连续失败自动禁用阈值（§18.4）。 */
export const HOOK_FAILURE_LIMIT = 10;

/** 项目级 hooks 的启用记录（§18.5 指纹）。 */
export interface ProjectHookApproval {
  /** 文件内容 hash（变更即需重新确认）。 */
  fingerprint: string;
  /** 一次性确认的时间。 */
  approvedAt: string;
  /** 用户审查时看到的命令全文（留痕）。 */
  commands: string[];
}
