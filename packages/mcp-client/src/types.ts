/**
 * MCP 协议数据类型（对齐 2025-06-18 规范，M8 §8.2+）。
 * 仅定义客户端消费所需的字段子集，保持零重依赖。
 */
import type { JSONSchema } from '@mozi/tools';

export const PROTOCOL_VERSION = '2025-06-18';

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
  roots?: { listChanged?: boolean };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version?: string };
  instructions?: string;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpPromptDef {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** tools/call 返回 content 元素。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

export interface ToolCallResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; text?: string } } | { type: 'image'; data: string; mimeType: string };
}

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

export type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'offline';

/** 单个 server 的配置增强（来自 config.json，见 §8.12）。 */
export interface McpServerOptions {
  /** 工具信任档位。 */
  trust?: 'ask' | 'allow' | 'deny';
  /** 白名单工具（未列出则注册但不默认 allow）。 */
  allowedTools?: string[];
  /** sampling 授权档位，默认 deny。 */
  sampling?: 'deny' | 'ask' | 'allow';
  /** 是否可信（影响 riskLevel）。 */
  trusted?: boolean;
  samplingEnabled?: boolean;
  samplingAllowServers?: string[];
}

/** 反向请求上下文：调用方注入的回调（UI 冒泡 / Provider 池）。 */
export interface SamplingContext {
  enabled: boolean;
  allowServers: string[];
  maxTokens: number;
  /** 取当前 executor 模型执行一次 chat（无工具、非流式）。 */
  runChat(messages: unknown[], maxTokens: number): Promise<{ text: string; usage?: unknown }>;
  /** 发起审批冒泡，返回用户决策。 */
  requestApproval(info: {
    serverId: string;
    requestId: string;
    promptPreview: string;
    maxTokens: number;
  }): Promise<'allow' | 'deny'>;
}
