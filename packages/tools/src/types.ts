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
  /** 工具内部产生的旁路事件（如 subagent.progress）。 */
  emit?: (e: AgentEvent) => void;
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
