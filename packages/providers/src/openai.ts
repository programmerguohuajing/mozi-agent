/**
 * OpenAI 兼容适配器（M4 §4.4）：用 Node 内置 fetch + 手写 SSE 解析，
 * 覆盖 DeepSeek / Qwen / GLM / Ollama / vLLM 等 90% 端点（零 SDK 依赖）。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { AssistantMessage, ChatMessage, TokenUsage } from '@mozi/shared';
import { StreamAggregator } from './aggregator.js';
import { Stream } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMStream,
  ProviderCapabilities,
  StreamEvent,
} from './types.js';

export interface OpenAIConfig {
  baseUrl: string; // e.g. https://api.deepseek.com/v1
  /**
   * API Key（可选）：本地 OpenAI 兼容服务（如 FreeLLMAPI / Ollama / LM Studio）
   * 无需鉴权时可不提供，请求将不带 Authorization 头。
   */
  apiKey?: () => string | undefined;
  /**
   * 上游模型名。可为空 —— 由网关自动路由（FreeLLMAPI 智能路由），
   * 此时请求体不带 model 字段。
   */
  model: string;
  /** 注册名（registry key）；默认取 model，自动路由时应传 provider id。 */
  id?: string;
  extra?: Record<string, unknown>;
}

/** OpenAI 兼容 /chat/completions 流式分片的最小结构（仅声明用到的字段）。 */
interface OpenAiToolCallDelta {
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface OpenAiDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChunk {
  choices?: Array<{ delta?: OpenAiDelta }>;
  usage?: OpenAiUsage;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;

  constructor(private readonly cfg: OpenAIConfig) {
    this.id = cfg.id ?? cfg.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      parallelToolCalls: true,
      vision: false,
      reasoning: false,
      maxContextTokens: 128_000,
      streamingToolArgs: true,
      systemPromptAsSeparateField: false,
    };
  }

  chat(req: ChatRequest): LLMStream {
    const agg = new StreamAggregator();
    return new Stream(this.run(req, agg), () => agg.finish());
  }

  private async *run(req: ChatRequest, agg: StreamAggregator): AsyncGenerator<StreamEvent> {
    const body = {
      // model 为空（网关自动路由，如 FreeLLMAPI）：不带 model 字段，由网关选模型。
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      messages: toOpenAiMessages(req.messages),
      tools: req.tools?.length ? req.tools.map(toOpenAiTool) : undefined,
      stream: true,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxOutputTokens,
      ...(this.cfg.extra ?? {}),
    };

    let res: Response;
    const apiKey = this.cfg.apiKey?.();
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 本地无鉴权端点（FreeLLMAPI / Ollama 等）：无 key 时不带 Authorization。
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new MoziError(ErrorCodes.ERR_PROVIDER_UNAVAILABLE, `fetch failed: ${String(e)}`, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new MoziError(
        ErrorCodes.ERR_PROVIDER_UNAVAILABLE,
        `HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }
    if (!res.body) throw new MoziError(ErrorCodes.ERR_PROVIDER_UNAVAILABLE, 'empty response body');

    yield* this.parseSse(res.body, agg);
  }

  private async *parseSse(
    body: ReadableStream<Uint8Array>,
    agg: StreamAggregator,
  ): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let head = ''; // 响应体开头快照（零事件时用于错误预览）
    let sawChunk = false; // 是否收到过任何合法 SSE data 分片
    let sawDone = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        if (head.length < 200) head += decoded;
        buf += decoded;
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            sawDone = true;
            return;
          }
          try {
            const json = JSON.parse(data) as OpenAiChunk;
            sawChunk = true;
            for (const ev of this.handleChunk(json)) {
              agg.feed(ev);
              yield ev;
            }
          } catch {
            // 跳过非法分片（如心跳注释），不中断流
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    // 零事件检测（修复"发完即完成、不报错"）：端点返回 200 但整个流没有
    // 任何合法 SSE 分片 —— 说明响应体不是 SSE（JSON 错误对象 / HTML 页面 /
    // 空白）。此时必须抛错，否则聚合器产出空消息，引擎静默 task.completed。
    if (!sawChunk && !sawDone) {
      const preview = head.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new MoziError(
        ErrorCodes.ERR_PROVIDER_UNAVAILABLE,
        `端点未返回有效的流式响应${preview ? `（内容开头：${preview}）` : '（响应为空）'}。请检查 Base URL / API 格式是否正确、模型名是否存在，或该服务是否支持流式输出。`,
      );
    }
  }

  private handleChunk(json: OpenAiChunk): StreamEvent[] {
    const out: StreamEvent[] = [];
    const delta = json.choices?.[0]?.delta;
    if (delta?.content) out.push({ type: 'text.delta', text: String(delta.content) });
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) out.push({ type: 'reasoning.delta', text: String(reasoning) });
    if (delta?.tool_calls) {
      for (const t of delta.tool_calls) {
        const index = t.index ?? 0;
        if (t.function?.name) {
          out.push({ type: 'toolcall.args.delta', index, fragment: '', name: t.function.name });
        }
        if (t.function?.arguments) {
          out.push({ type: 'toolcall.args.delta', index, fragment: String(t.function.arguments) });
        }
      }
    }
    if (json.usage) out.push({ type: 'usage', usage: normalizeUsage(json.usage, this.cfg.model) });
    return out;
  }
}

function normalizeUsage(u: OpenAiUsage, model: string): TokenUsage {
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: Number(u.total_tokens ?? input + output),
    model,
  };
}

function toOpenAiTool(t: { name: string; description: string; parameters: unknown }): unknown {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'user') {
      return {
        role: 'user',
        content: m.content.map((c) => {
          if (c.type === 'text') return { type: 'text', text: c.text };
          if (c.type === 'image') return { type: 'image_url', image_url: { url: c.dataUrl } };
          return { type: 'text', text: `[file:${c.path}] ${c.ref}` };
        }),
      };
    }
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content ?? null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      return msg;
    }
    return { role: 'tool', tool_call_id: m.callId, content: m.content };
  });
}
