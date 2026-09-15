/**
 * Anthropic Messages API 适配器（M4 §4.2）。
 * 支持流式响应、tool_use、多模态。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { AssistantMessage, TokenUsage } from '@mozi/shared';
import { StreamAggregator } from './aggregator.js';
import {
  extractAnthropicText,
  extractAnthropicToolCalls,
  parseAnthropicStreamEvent,
  toAnthropicMessages,
} from './message-converter.js';
import type {
  AnthropicChatRequest,
  AnthropicContentBlock,
  AnthropicStreamEvent,
} from './message-converter.js';
import { Stream } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMStream,
  ProviderCapabilities,
  StreamEvent,
} from './types.js';

export interface AnthropicConfig {
  /** API Key（可选）：本地 Anthropic 兼容代理无鉴权时可不提供。 */
  apiKey?: () => string | undefined;
  /** 上游模型名。可为空（网关自动路由），此时请求体不带 model 字段。 */
  model: string;
  /** 注册名（registry key）；默认取 model。 */
  id?: string;
  baseUrl?: string; // default: https://api.anthropic.com
  extra?: Record<string, unknown>;
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(private readonly cfg: AnthropicConfig) {
    this.id = cfg.id ?? cfg.model;
    this.baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com';
  }

  capabilities(): ProviderCapabilities {
    return {
      parallelToolCalls: true,
      vision: true,
      reasoning: false,
      maxContextTokens: 200_000,
      streamingToolArgs: true,
      systemPromptAsSeparateField: true,
    };
  }

  chat(req: ChatRequest): LLMStream {
    const agg = new StreamAggregator();
    return new Stream(this.run(req, agg), () => agg.finish());
  }

  private async *run(req: ChatRequest, agg: StreamAggregator): AsyncGenerator<StreamEvent> {
    const body: AnthropicChatRequest = toAnthropicMessages(req.messages, {
      tools: req.tools,
      parallelToolCalls: req.tools?.length ? true : undefined,
    });
    // model 为空（网关自动路由）：不带 model 字段。
    if (this.cfg.model) body.model = this.cfg.model;
    body.max_tokens = req.maxOutputTokens ?? 4096;
    body.stream = true;
    body.temperature = req.temperature ?? 0;
    body.stop_sequences = req.stopSequences;
    body.extra_body = this.cfg.extra;

    let res: Response;
    const apiKey = this.cfg.apiKey?.();
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 本地无鉴权端点：无 key 时不带 x-api-key。
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          'anthropic-version': '2023-06-01',
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
            const json = JSON.parse(data) as AnthropicStreamEvent;
            for (const ev of this.handleEvent(json)) {
              agg.feed(ev);
              yield ev;
            }
            if (json.type === 'message_stop') return;
          } catch {
            // 跳过非法分片
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(evt: AnthropicStreamEvent): StreamEvent[] {
    const out: StreamEvent[] = [];

    if (evt.type === 'text_delta') {
      out.push({ type: 'text.delta', text: evt.text });
    }

    if (evt.type === 'tool_use') {
      out.push({
        type: 'toolcall.args.delta',
        index: evt.index,
        fragment: '',
        name: evt.name,
      });
    }

    if (evt.type === 'message_start') {
      for (const block of evt.message.content) {
        if (block.type === 'text') {
          out.push({ type: 'text.delta', text: block.text ?? '' });
        }
        if (block.type === 'tool_use') {
          out.push({
            type: 'toolcall.args.delta',
            index: 0,
            fragment: '',
            name: block.name,
          });
        }
      }
    }

    if (evt.type === 'message_stop') {
      // no-op
    }

    return out;
  }
}
