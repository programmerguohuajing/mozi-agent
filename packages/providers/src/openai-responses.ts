/**
 * OpenAI Responses API 适配器（M4 §4.2）。
 * 支持流式响应、tool_use、多模态。
 * API 文档: https://platform.openai.com/docs/api-reference/responses
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { AssistantMessage, TokenUsage } from '@mozi/shared';
import { StreamAggregator } from './aggregator.js';
import { toOpenAiResponsesRequest } from './message-converter.js';
import type { OpenAIResponseOutputMessage, OpenAIResponsesRequest } from './message-converter.js';
import { Stream } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMStream,
  ProviderCapabilities,
  StreamEvent,
} from './types.js';

export interface OpenAIResponsesConfig {
  /** API Key（可选）：本地 Responses 兼容代理无鉴权时可不提供。 */
  apiKey?: () => string | undefined;
  /** 上游模型名。可为空（网关自动路由），此时请求体不带 model 字段。 */
  model: string;
  /** 注册名（registry key）；默认取 model。 */
  id?: string;
  baseUrl?: string; // default: https://api.openai.com
  extra?: Record<string, unknown>;
}

/** Responses API 流式事件的最小结构（仅声明用到的字段）。 */
interface ResponsesData {
  chunks?: Array<{ text?: string }>;
  type?: string;
  name?: string;
  call_index?: number;
  partial_json?: string;
}

interface ResponsesChunk {
  type?: string;
  delta?: string;
  data?: ResponsesData;
  token?: string;
  response?: { usage?: { input_tokens?: number; output_tokens?: number } };
  message?: string;
  error?: { message?: string };
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(private readonly cfg: OpenAIResponsesConfig) {
    this.id = cfg.id ?? (cfg.model ? `responses:${cfg.model}` : 'responses:auto');
    this.baseUrl = cfg.baseUrl ?? 'https://api.openai.com';
  }

  capabilities(): ProviderCapabilities {
    return {
      parallelToolCalls: true,
      vision: true,
      reasoning: true,
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
    const body: OpenAIResponsesRequest = toOpenAiResponsesRequest(req.messages, {
      tools: req.tools,
      parallelToolCalls: req.tools?.length ? true : undefined,
    });
    // model 为空（网关自动路由）：不带 model 字段。
    if (this.cfg.model) body.model = this.cfg.model;
    body.max_output_tokens = req.maxOutputTokens;
    body.stream = true;
    body.temperature = req.temperature ?? 0;
    body.stop_sequences = req.stopSequences;
    body.extra_body = this.cfg.extra;

    let res: Response;
    const apiKey = this.cfg.apiKey?.();
    try {
      res = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 本地无鉴权端点：无 key 时不带 Authorization。
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
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const json = JSON.parse(data) as ResponsesChunk;
            for (const ev of this.handleChunk(json)) {
              agg.feed(ev);
              yield ev;
            }
          } catch {
            // 跳过非法分片
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleChunk(json: ResponsesChunk): StreamEvent[] {
    const out: StreamEvent[] = [];

    // Responses API 事件类型
    const type = json.type;

    if (type === 'response.delta') {
      const delta = json.delta;
      if (delta === 'text' || delta === 'input_text' || delta === 'output_text') {
        // 从 delta.data 中获取文本
        const textChunks = json.data?.chunks;
        if (textChunks) {
          for (const chunk of textChunks) {
            if (chunk.text) {
              out.push({ type: 'text.delta', text: chunk.text });
            }
          }
        }
      }
      if (delta === 'tool_calls') {
        // tool call 参数增量
        const tc = json.data;
        if (tc?.type === 'function_call' && tc.name) {
          out.push({
            type: 'toolcall.args.delta',
            index: tc.call_index ?? 0,
            fragment: '',
            name: tc.name,
          });
        }
        if (tc?.partial_json) {
          out.push({
            type: 'toolcall.args.delta',
            index: tc.call_index ?? 0,
            fragment: tc.partial_json,
          });
        }
      }
    }

    if (type === 'response.output_token') {
      // 单条输出 token 事件
      const token = json.token;
      if (typeof token === 'string') {
        out.push({ type: 'text.delta', text: token });
      }
    }

    if (type === 'response.done' || type === 'done') {
      // 响应完成，提取 usage
      const response = json.response;
      if (response?.usage) {
        out.push({
          type: 'usage',
          usage: {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
            model: this.cfg.model,
          },
        });
      }
    }

    if (type === 'error') {
      const errMsg = json.message || json.error?.message || 'Unknown error';
      throw new MoziError(ErrorCodes.ERR_PROVIDER_UNAVAILABLE, `Responses API error: ${errMsg}`);
    }

    return out;
  }
}
