/**
 * 事件全集（M2 §2.2 最终定义）。
 * 每个事件带 ts(ISO8601) 与 sessionId（session.started 例外），用于排序与重放。
 */
import type { AgentError, AssistantMessage, TokenUsage, ToolCall, ToolResult } from './messages.js';
import type { ApprovalReason } from './policy-types.js';

export type TaskCompleteReason =
  | 'model_finished'
  | 'max_steps_exceeded'
  | 'user_interrupt'
  | 'token_budget_exceeded'
  | 'cost_limit_reached';

export interface CommandSegment {
  text: string;
  argv: string[];
  risk: 'safe' | 'side-effect' | 'network' | 'high';
  matchedRule?: string;
  color: 'green' | 'yellow' | 'red';
}

export type AgentEvent =
  // 会话
  | { type: 'session.started'; sessionId: string; config: unknown; ts: string }
  | { type: 'session.resumed'; sessionId: string; replayedEvents: number; ts: string }
  | {
      type: 'session.terminated';
      sessionId: string;
      reason: 'user' | 'error' | 'shutdown';
      ts: string;
    }
  // 轮次与输出
  | { type: 'turn.started'; turnId: string; input: string; ts: string }
  | { type: 'message.delta'; text: string; ts: string }
  | { type: 'message.completed'; message: AssistantMessage; ts: string }
  // 工具生命周期
  | { type: 'tool.requested'; call: ToolCall; ts: string }
  | { type: 'tool.approval.required'; call: ToolCall; reason: ApprovalReason; ts: string }
  | {
      type: 'tool.approval.resolved';
      callId: string;
      decision: 'allow' | 'deny';
      by: 'user' | 'policy';
      ts: string;
    }
  | { type: 'tool.started'; callId: string; ts: string }
  | { type: 'tool.completed'; callId: string; result: ToolResult; ts: string }
  // 上下文
  | {
      type: 'context.compacted';
      removedTurns: number;
      savedTokens: number;
      summary: string;
      ts: string;
    }
  // 用量与终止
  | { type: 'token.usage'; usage: TokenUsage; ts: string }
  | { type: 'turn.completed'; usage: TokenUsage; steps: number; ts: string }
  | { type: 'task.completed'; reason: TaskCompleteReason; ts: string }
  | { type: 'error'; error: AgentError; recoverable: boolean; ts: string }
  | { type: 'internal.debug'; message: string; data?: unknown; ts: string }
  // v1.2 新增：MCP 客户端事件（M8 §8.15）
  | {
      type: 'mcp.server.status';
      serverId: string;
      status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'offline';
      detail?: string;
      ts: string;
    }
  | {
      type: 'mcp.sampling.requested';
      serverId: string;
      requestId: string;
      promptPreview: string;
      maxTokens: number;
      estCostUsd?: number;
      ts: string;
    }
  | {
      type: 'mcp.sampling.resolved';
      requestId: string;
      decision: 'allow' | 'deny';
      usage?: TokenUsage;
      ts: string;
    }
  | {
      type: 'mcp.elicit.requested';
      serverId: string;
      requestId: string;
      message: string;
      schema: Record<string, unknown>;
      ts: string;
    }
  | {
      type: 'mcp.elicit.resolved';
      requestId: string;
      decision: 'submit' | 'cancel';
      values?: Record<string, unknown>;
      ts: string;
    }
  // v1.1 新增：子智能体编排事件（M12 §12.8）
  | {
      type: 'subagent.started';
      subSessionId: string;
      parentSessionId: string;
      agentType: string;
      prompt: string;
      ts: string;
    }
  | { type: 'subagent.queued'; subSessionId: string; queuePosition: number; ts: string }
  | {
      type: 'subagent.progress';
      subSessionId: string;
      step: number;
      maxSteps: number;
      currentTool?: string;
      tokensUsed: number;
      ts: string;
    }
  | {
      type: 'subagent.approval.required';
      subSessionId: string;
      callId: string;
      agentType: string;
      call: ToolCall;
      reason: ApprovalReason;
      ts: string;
    }
  | {
      type: 'subagent.completed';
      subSessionId: string;
      summary: string;
      usage: TokenUsage;
      steps: number;
      durationMs: number;
      ts: string;
    }
  | { type: 'subagent.failed'; subSessionId: string; error: AgentError; ts: string };

export function eventTimestamp(date = new Date()): string {
  return date.toISOString();
}
