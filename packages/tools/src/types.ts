/**
 * 工具系统类型与结果构造辅助（M3 §3.2）。
 */
import type {
  AgentEvent,
  DisplayPayload,
  RiskLevel,
  SandboxRunner,
  ToolResult,
} from '@mozi/shared';
import type { Workspace } from './workspace.js';

/** 会话级状态的可选视图（引擎注入；避免 tools 包反向依赖 core）。 */
export interface SessionStateView {
  id: string;
  /** 会话级可变元数据（todo_list 工具读写）。 */
  meta: Record<string, unknown>;
  /** 子智能体嵌套深度（task 工具校验，默认 0）。 */
  depth?: number;
  /** 本轮已派发子 Agent 数。 */
  subSpawnCount?: number;
  /** 工具白名单（'*' 或显式列表）。 */
  enabledTools?: string[];
}

/** 记忆写入/检索契约（M16 §16.4）：由 core 的 MemoryStore 实现，避免 tools 反向依赖 core。 */
export interface MemoryAccess {
  /** 显式写入（memory_write 工具）；检测到密钥时抛错。 */
  write(req: {
    layer: 'user' | 'project';
    type: 'fact' | 'preference' | 'decision';
    content: string;
    evidence?: string;
  }): { entry: { id: string; content: string }; merged: boolean; replaced?: string };
  /** 记忆检索（memory_search 工具）。 */
  search(
    query: string,
    opts?: { layer?: 'user' | 'project' | 'semantic'; limit?: number },
  ): Array<{ entry: { id: string; layer: string; type: string; content: string; source: string }; score: number }>;
  /** 删除条目（memory_forget 工具）。 */
  forget(id: string): boolean;
}

/** 截图/视觉契约（M17 §17.3）：由 core 的图片管线实现。 */
export interface VisionAccess {
  /** 主动截图；返回落盘路径 + OCR 摘要。 */
  screenshot(input: {
    target?:
      | { kind: 'screen' }
      | { kind: 'window'; title: string }
      | { kind: 'browser'; url: string; waitMs?: number; fullPage?: boolean };
    annotate?: { highlight?: string };
  }): Promise<{
    /** 落盘图片相对/绝对路径。 */
    path: string;
    /** contentId（事件只带此 id，§17.2）。 */
    contentId: string;
    /** OCR 文本摘要（截断）。 */
    ocrText?: string;
    /** 估算图片 token（计费，§17.2）。 */
    estimatedTokens?: number;
    /** 是否由 headless 浏览器模式产生。 */
    browser?: boolean;
  }>;
}

export interface ToolContext {
  workspace: Workspace;
  signal: AbortSignal;
  sessionId: string;
  /** 可选沙箱执行器（M6 §6.4）：当引擎注入了沙箱时，shell 工具经此通道执行命令。 */
  sandbox?: SandboxRunner;
  /** 当前会话状态（todo_list / task 用）。 */
  session?: SessionStateView;
  /** 子智能体监督者（M12 §12.4，task 工具用）。 */
  supervisor?: SubAgentDispatcher;
  /** 记忆访问（M16；未注入时 memory_* 工具返回明确错误）。 */
  memory?: MemoryAccess;
  /** 视觉访问（M17；未注入时 screenshot 工具返回明确错误）。 */
  vision?: VisionAccess;
  /** 浏览器访问（内置浏览器；未注入时 browser 工具返回明确错误）。 */
  browser?: BrowserAccess;
  /** 工具内部产生的旁路事件（如 subagent.progress）。 */
  emit?: (e: AgentEvent) => void;
}

/** 内置浏览器访问契约：由桌面端 Electron BrowserView 或 CLI HTTP fetch 实现。 */
export interface BrowserAccess {
  /** 导航到 URL，返回页面基本信息。 */
  navigate(url: string, opts?: { waitMs?: number }): Promise<{ title: string; url: string; status: number }>;
  /** 截取当前页面截图（base64 PNG）。 */
  screenshot(opts?: { fullPage?: boolean }): Promise<{ contentId: string; base64: string }>;
  /** 提取页面纯文本内容。 */
  getText(): Promise<{ text: string; truncated: boolean }>;
  /** 获取页面 HTML。 */
  getHtml(): Promise<{ html: string; truncated: boolean }>;
  /** 按 CSS 选择器点击元素。 */
  click(selector: string): Promise<{ ok: boolean; error?: string }>;
  /** 填充表单字段。 */
  fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }>;
  /** 在页面上下文执行 JavaScript（受限于安全策略）。 */
  eval(script: string): Promise<{ result: unknown; error?: string }>;
  /** 关闭当前标签页/浏览器。 */
  close(): Promise<void>;
  /** 列出已打开的标签页。 */
  listTabs(): Promise<Array<{ id: string; url: string; title: string; active: boolean }>>;
}

/** task 工具需要的派发契约（由 core 的 SubAgentSupervisor 实现）。 */
export interface SubAgentDispatcher {
  dispatch(
    spec: { agent: string; prompt: string; contextFiles?: string[]; timeoutMs?: number },
    ctx: ToolContext,
  ): Promise<ToolResult>;
  templates(): Array<{ type: string; description: string }>;
  maxDepth: number;
}

export type JSONSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export interface AgentTool<TInput = Record<string, unknown>> {
  name: string;
  version: string;
  description: string;
  parameters: JSONSchema;
  riskLevel: RiskLevel;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/** 模型可见的 schema（provider 层再按需裁剪 description 长度）。 */
export function toolSchema(tool: AgentTool): {
  name: string;
  description: string;
  parameters: unknown;
} {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** 成功结果（引擎会回填 callId）。 */
export function ok(content: string, display?: DisplayPayload): ToolResult {
  return { callId: '', content, isError: false, display };
}

/** 失败结果（引擎会回填 callId）。 */
export function fail(content: string, errorKind?: string): ToolResult {
  return { callId: '', content, isError: true, meta: errorKind ? { errorKind } : undefined };
}

/** 通用输出截断：保留 head + tail，中间省略并给出可恢复提示。 */
export function truncate(
  text: string,
  head = 200,
  tail = 50,
): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return { text, truncated: false };
  return {
    text: [
      ...lines.slice(0, head),
      `\n...[${lines.length - head - tail} lines truncated]...`,
      ...lines.slice(-tail),
    ].join('\n'),
    truncated: true,
  };
}
