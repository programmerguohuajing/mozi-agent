/**
 * LLM Provider 层对外契约（M4 §4.2）。
 */
import type { AssistantMessage, TokenUsage } from '@mozi/shared';

export interface ChatRequest {
  messages: import('@mozi/shared').ChatMessage[];
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  onUsage?: (usage: TokenUsage) => void;
  /** 发起本次请求的会话 id（子智能体测试按 sessionId 分派脚本，M12 §12.13）。 */
  sessionId?: string;
}

export type StreamEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'toolcall.args.delta'; index: number; fragment: string; name?: string }
  | { type: 'usage'; usage: TokenUsage };

export interface ProviderCapabilities {
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContextTokens: number;
  streamingToolArgs: boolean;
  systemPromptAsSeparateField: boolean;
}

export interface LLMStream {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  /** 流迭代完成后调用，返回聚合后的最终 assistant message */
  result(): AssistantMessage;
}

export interface LLMProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  chat(req: ChatRequest): LLMStream;
}
