/**
 * 消息与调用类型：内部统一格式。
 * 各 Provider 负责与自家 API 格式互转，引擎层完全无感。
 */
import type { SandboxLevel } from './sandbox.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type UserContent =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string; alt?: string }
  | { type: 'file'; path: string; ref: string };

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: UserContent[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
  reasoning?: string; // provider 剥离后供 UI 展示，不入上下文
  usage?: TokenUsage;
}

export interface ToolMessage {
  role: 'tool';
  callId: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type RiskLevel = 'read' | 'write' | 'exec' | 'meta';

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  riskLevel: RiskLevel;
}

export type DisplayPayload =
  | { kind: 'diff'; file: string; before: string; after: string; hunks: number }
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'json'; data: unknown }
  | { kind: 'tree'; entries: string[] };

export interface ToolResult {
  callId: string;
  content: string;
  display?: DisplayPayload;
  isError: boolean;
  meta?: {
    durationMs?: number;
    truncated?: boolean;
    exitCode?: number;
    errorKind?: string;
    /** 经沙箱执行时记录实际隔离级别（M6 §6.4）。 */
    sandboxLevel?: SandboxLevel;
    sandboxDegradedFrom?: SandboxLevel;
    sandboxNote?: string;
    /** task 工具：子会话 id（M12 §12.4），供主模型按需读取子日志。 */
    subSessionId?: string;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  model: string;
}

export interface AgentError {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}
