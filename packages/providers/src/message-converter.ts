/**
 * 消息格式转换器：内部 ChatMessage <-> 各 Provider 原生格式。
 * 四种格式：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses API / Gemini generateContent。
 */
import type { AssistantMessage, ChatMessage, ToolCall, UserContent } from '@mozi/shared';

// ---------------------------------------------------------------------------
// Internal types used by converters (not exported)
// ---------------------------------------------------------------------------

export type MessageFormat = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

export interface ConversionOptions {
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  parallelToolCalls?: boolean;
}

// ---------------------------------------------------------------------------
// Anthropic Messages types
// ---------------------------------------------------------------------------

export interface AnthropicSystemText {
  type: 'text';
  text: string;
}
export interface AnthropicSystemImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}
export type AnthropicSystemContent = AnthropicSystemText | AnthropicSystemImage;

export interface AnthropicMessageRequest {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}
export type AnthropicContentBlock =
  | { type: 'text'; text?: string; cache_control?: unknown }
  | { type: 'image'; source: AnthropicContentBlockImageSource }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    };

export interface AnthropicContentBlockImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface AnthropicChatRequest {
  model: string;
  system: AnthropicSystemContent[] | string;
  messages: AnthropicMessageRequest[];
  tools?: AnthropicTool[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  stop_sequences?: string[];
  extra_body?: Record<string, unknown>;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: boolean;
}

export interface AnthropicStreamTextDelta {
  type: 'text_delta';
  text: string;
  partial_json?: string;
}
export interface AnthropicStreamToolUseDelta {
  type: 'tool_use';
  id: string;
  name: string;
  index: number;
}
export interface AnthropicStreamMessageStart {
  type: 'message_start';
  message: {
    role: 'assistant';
    content: AnthropicContentBlock[];
    stop_type?: 'end_turn' | 'max_tokens';
  };
}
export interface AnthropicStreamMessageStop {
  type: 'message_stop';
}
export interface AnthropicStreamUsage {
  type: 'ping';
  usage?: { output_tokens?: number };
}
export type AnthropicStreamEvent =
  | AnthropicStreamTextDelta
  | AnthropicStreamToolUseDelta
  | AnthropicStreamMessageStart
  | AnthropicStreamMessageStop
  | AnthropicStreamUsage;

// ---------------------------------------------------------------------------
// OpenAI Chat Completions types (already in openai.ts, re-exported here)
// ---------------------------------------------------------------------------

export interface OpenAIChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface OpenAIChatDelta {
  role?: 'user' | 'assistant' | 'system';
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIChatToolCall[];
}
export interface OpenAIChatChoice {
  delta: OpenAIChatDelta;
  finish_reason: string | null;
}
export interface OpenAIChatStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API types
// ---------------------------------------------------------------------------

export interface OpenAIResponseInputMessage {
  role: 'user' | 'assistant';
  content: string | OpenAIResponseContentBlock[];
}
export type OpenAIResponseContentBlock =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; file_url: string; file_type: string }
  | { type: 'output_text'; text: string; cache_control?: unknown };

export interface OpenAIResponseToolFunction {
  type: 'function';
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  parallel?: boolean;
}

export interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIResponseInputMessage[];
  tools?: OpenAIResponseToolFunction[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop_sequences?: string[];
  previous_response_id?: string;
  extra_body?: Record<string, unknown>;
}

export interface OpenAIResponseOutputToolCall {
  id: string;
  type: 'function';
  name: string;
  arguments: string;
  call_index?: number;
}

export interface OpenAIResponseOutputMessage {
  id: string;
  object: 'response';
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete';
  output: Array<{
    id: string;
    type: 'message';
    role: 'assistant';
    content: OpenAIResponseStreamContentBlock[];
  }>;
}

export interface OpenAIResponseMessageDelta {
  index: number;
  type: 'message';
  delta: { content?: Record<number, OpenAIResponseTextContent[]>; role?: string };
}

export type OpenAIResponseStreamContentBlock =
  | { type: 'message_start'; index: number; id: string }
  | {
      type: 'message_delta';
      stop_reason?: 'end_turn' | 'max_tokens' | 'tool_calls';
      output: OpenAIResponseMessageDelta[];
    }
  | {
      type: 'response';
      response: { id: string; usage?: { input_tokens: number; output_tokens: number } };
    }
  | { type: 'error'; message: { type: 'error'; message: string }; last_event_id: number };

export interface OpenAIResponseTextContent {
  type: 'output_text';
  text: string;
}

export interface OpenAIResponseToolCallContent {
  type: 'tool_calls';
  id: string;
  name: string;
  arguments: string;
  call_index?: number;
  output_index?: number;
}

// ---------------------------------------------------------------------------
// Gemini generateContent types
// ---------------------------------------------------------------------------

export interface GeminiFileReference {
  file_uri: string;
  file_name: string;
}

export interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  name: string;
  response?: Record<string, unknown>;
}

export type GeminiContentPart =
  | { type: 'text'; text: string }
  | { type: 'inline_data'; mime_type: string; data: string }
  | { type: 'file_data'; file_uri: string; mime_type: string }
  | { type: 'function_call'; functionCall: GeminiFunctionCall }
  | { type: 'function_response'; functionResponse: GeminiFunctionResponse };

export interface GeminiContent {
  role: 'user' | 'model' | 'system' | 'function';
  parts: GeminiContentPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiFunctionResponsePart {
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiChatRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: {
    maxOutputTokens: number;
    temperature?: number;
    stopSequences?: string[];
  };
  stream?: boolean;
}

export interface GeminiCandidates {
  index: number;
  content: GeminiContent;
  finishReason?: string;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface GeminiStreamChunk {
  candidates: GeminiCandidates[];
  usageMetadata?: GeminiCandidates['usageMetadata'];
}

// ---------------------------------------------------------------------------
// Public conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert internal ChatMessage[] to Anthropic Messages format.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  opts?: ConversionOptions,
): AnthropicChatRequest {
  const systemParts: AnthropicSystemContent[] = [];
  const anthropicMessages: AnthropicMessageRequest[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push({ type: 'text', text: msg.content });
      continue;
    }
    anthropicMessages.push(toAnthropicMessage(msg));
  }

  if (systemParts.length === 1) {
    const [sys] = systemParts;
    if (sys?.type === 'text') {
      return {
        model: '',
        system: sys.text,
        messages: anthropicMessages,
        tools: opts?.tools?.map(toAnthropicTool),
        max_tokens: 4096,
      };
    }
    if (sys) {
      return {
        model: '',
        system: [sys],
        messages: anthropicMessages,
        tools: opts?.tools?.map(toAnthropicTool),
        max_tokens: 4096,
      };
    }
  }
  return {
    model: '',
    system: systemParts.length ? systemParts : [{ type: 'text', text: '' }],
    messages: anthropicMessages,
    tools: opts?.tools?.map(toAnthropicTool),
    max_tokens: 4096,
  };
}

function toAnthropicMessage(msg: ChatMessage): AnthropicMessageRequest {
  if (msg.role === 'user') {
    return {
      role: 'user',
      content: toAnthropicContentBlocks(msg.content),
    };
  }
  if (msg.role === 'assistant') {
    const blocks: AnthropicContentBlock[] = [];
    if (msg.content) blocks.push({ type: 'text', text: msg.content });
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input:
            typeof tc.arguments === 'string'
              ? JSON.parse(tc.arguments)
              : (tc.arguments as Record<string, unknown>),
        });
      }
    }
    if (msg.reasoning) {
      blocks.unshift({ type: 'text', text: msg.reasoning });
    }
    return { role: 'assistant', content: blocks };
  }
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.callId,
          content: msg.content,
          is_error: msg.isError,
        },
      ],
    };
  }
  return { role: 'user', content: [{ type: 'text', text: msg.content }] };
}

function toAnthropicContentBlocks(contents: UserContent[]): AnthropicContentBlock[] {
  return contents.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text };
    if (c.type === 'image') {
      const mediaType = extractMediaType(c.dataUrl);
      const data = c.dataUrl.replace(/^data:[^;]+;base64,/, '');
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
    return { type: 'text', text: `[file:${c.path}] ${c.ref}` };
  });
}

function toAnthropicTool(t: {
  name: string;
  description: string;
  parameters: unknown;
}): AnthropicTool {
  return {
    name: t.name,
    description: t.description,
    input_schema: (t.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  };
}

/**
 * Convert internal ChatMessage[] to OpenAI Chat Completions format.
 */
export function toOpenAiChatMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
      continue;
    }
    result.push(toOpenAiChatMessage(msg));
  }
  return result;
}

function toOpenAiChatMessage(msg: ChatMessage): unknown {
  if (msg.role === 'user') {
    return {
      role: 'user',
      content: msg.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        if (c.type === 'image') return { type: 'image_url', image_url: { url: c.dataUrl } };
        return { type: 'text', text: `[file:${c.path}] ${c.ref}` };
      }),
    };
  }
  if (msg.role === 'assistant') {
    const m: Record<string, unknown> = { role: 'assistant', content: msg.content ?? null };
    if (msg.toolCalls?.length) {
      m.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments:
            typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      }));
    }
    return m;
  }
  if (msg.role === 'tool') {
    return { role: 'tool', tool_call_id: msg.callId, content: msg.content };
  }
  return { role: 'user', content: String(msg.content) };
}

/**
 * Convert internal ChatMessage[] to OpenAI Responses API format.
 */
export function toOpenAiResponsesRequest(
  messages: ChatMessage[],
  opts?: ConversionOptions,
): OpenAIResponsesRequest {
  const input: OpenAIResponseInputMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // Responses API doesn't support system role directly
    input.push(toOpenAiResponseInputMessage(msg));
  }

  return {
    model: '',
    input: input.length ? input : [{ role: 'user', content: '' }],
    tools: opts?.tools?.map(toOpenAiResponseTool),
    max_output_tokens: opts?.tools ? 4096 : undefined,
  };
}

function toOpenAiResponseInputMessage(msg: ChatMessage): OpenAIResponseInputMessage {
  if (msg.role === 'user') {
    const blocks: OpenAIResponseContentBlock[] = msg.content.map((c) => {
      if (c.type === 'text') return { type: 'input_text', text: c.text };
      if (c.type === 'image') return { type: 'input_image', image_url: c.dataUrl };
      return { type: 'input_text', text: `[file:${c.path}] ${c.ref}` };
    });
    if (blocks.length === 1 && blocks[0] && blocks[0].type === 'input_text') {
      return { role: 'user', content: blocks[0].text };
    }
    return { role: 'user', content: blocks };
  }
  if (msg.role === 'assistant') {
    const textParts: string[] = [];
    if (msg.content) textParts.push(msg.content);
    if (msg.reasoning) textParts.push(msg.reasoning);
    return { role: 'assistant', content: textParts.join('\n') || '' };
  }
  if (msg.role === 'tool') {
    return { role: 'user', content: `Tool result for ${msg.callId}: ${msg.content ?? ''}` };
  }
  return { role: 'user', content: String(msg.content) };
}

function toOpenAiResponseTool(t: {
  name: string;
  description: string;
  parameters: unknown;
}): OpenAIResponseToolFunction {
  return {
    type: 'function',
    name: t.name,
    description: t.description,
    ...(t.parameters as Record<string, unknown>),
  };
}

/**
 * Convert internal ChatMessage[] to Gemini generateContent format.
 */
export function toGeminiMessages(
  messages: ChatMessage[],
  opts?: ConversionOptions,
): GeminiChatRequest {
  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiContent | undefined;

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { role: 'system', parts: [{ type: 'text', text: msg.content }] };
      continue;
    }
    contents.push(toGeminiContent(msg));
  }

  return {
    contents,
    systemInstruction,
    tools: opts?.tools?.length
      ? [{ functionDeclarations: opts.tools.map(toGeminiFunction) }]
      : undefined,
  };
}

function toGeminiContent(msg: ChatMessage): GeminiContent {
  if (msg.role === 'user') {
    return {
      role: 'user',
      parts: toGeminiParts(msg.content),
    };
  }
  if (msg.role === 'assistant') {
    const parts: GeminiContentPart[] = [];
    if (msg.content) parts.push({ type: 'text', text: msg.content });
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        parts.push({
          type: 'function_call',
          functionCall: {
            name: tc.name,
            args:
              typeof tc.arguments === 'string'
                ? JSON.parse(tc.arguments)
                : (tc.arguments as Record<string, unknown>),
          },
        });
      }
    }
    return { role: 'model', parts };
  }
  if (msg.role === 'tool') {
    return {
      role: 'function',
      parts: [
        {
          type: 'function_response',
          functionResponse: {
            name: `tool_${msg.callId}`,
            response: { result: msg.content },
          },
        },
      ],
    };
  }
  return { role: 'user', parts: [{ type: 'text', text: String(msg.content ?? '') }] };
}

function toGeminiParts(contents: UserContent[]): GeminiContentPart[] {
  return contents.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text };
    if (c.type === 'image') {
      const data = c.dataUrl.replace(/^data:/, '').split(';base64,');
      return {
        type: 'inline_data',
        mime_type: data[0]?.replace(/^image\//, 'image/') ?? 'image/png',
        data: c.dataUrl.replace(/^data:[^;]+;base64,/, ''),
      };
    }
    return { type: 'text', text: `[file:${c.path}] ${c.ref}` };
  });
}

function toGeminiFunction(t: {
  name: string;
  description: string;
  parameters: unknown;
}): GeminiFunctionDeclaration {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Reverse conversions (response parsing helpers)
// ---------------------------------------------------------------------------

/**
 * Extract Anthropic text content from assistant message.
 */
export function extractAnthropicText(content: AnthropicContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n');
}

/**
 * Extract Anthropic tool calls from assistant message.
 */
export function extractAnthropicToolCalls(content: AnthropicContentBlock[]): ToolCall[] {
  return content
    .filter(
      (b): b is AnthropicContentBlock & { type: 'tool_use'; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    )
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: JSON.stringify(b.input),
      riskLevel: 'write' as const,
    }));
}

/**
 * Parse Anthropic streaming events into internal events.
 */
export function parseAnthropicStreamEvent(data: string): Record<string, unknown> | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) return null;

  // Extract data line (Anthropic format: "event: {...}" or "data: {...}")
  let jsonStr = trimmed;
  if (trimmed.startsWith('event:')) {
    const lines = trimmed.split('\n');
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!dataLine) return null;
    jsonStr = dataLine.slice(5).trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractMediaType(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  return match?.[1] ?? 'image/png';
}
