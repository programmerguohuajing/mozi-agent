/**
 * Gemini generateContent API 适配器（M4 §4.2）。
 * 支持流式响应、function calling、多模态。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { AssistantMessage, TokenUsage } from '@mozi/shared';
import { StreamAggregator } from './aggregator.js';
import { toGeminiMessages } from './message-converter.js';
import type { GeminiChatRequest, GeminiStreamChunk } from './message-converter.js';
import { Stream } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMStream,
  ProviderCapabilities,
  StreamEvent,
} from './types.js';

export interface GeminiConfig {
  apiKey: () => string;
  model: string;
  baseUrl?: string; // default: https://generativelanguage.googleapis.com
  extra?: Record<string, unknown>;
}

export class GeminiProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(private readonly cfg: GeminiConfig) {
    this.id = cfg.model;
    this.baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  capabilities(): ProviderCapabilities {
    return {
      parallelToolCalls: true,
      vision: true,
      reasoning: true,
      maxContextTokens: 1_048_576, // 1M tokens
      streamingToolArgs: true,
      systemPromptAsSeparateField: true,
    };
  }

  chat(req: ChatRequest): LLMStream {
    const agg = new StreamAggregator();
    return new Stream(this.run(req, agg), () => agg.finish());
  }

  private async *run(req: ChatRequest, agg: StreamAggregator): AsyncGenerator<StreamEvent> {
    const body: GeminiChatRequest = toGeminiMessages(req.messages, {
      tools: req.tools,
    });
    body.generationConfig = {
      maxOutputTokens: req.maxOutputTokens ?? 8192,
      temperature: req.temperature ?? 0,
      stopSequences: req.stopSequences,
    };
    body.stream = true;

    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1beta/models/${this.cfg.model}:streamGenerateContent?key=${this.cfg.apiKey()}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        },
      );
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
            const json = JSON.parse(data) as GeminiStreamChunk;
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

  private handleChunk(json: GeminiStreamChunk): StreamEvent[] {
    const out: StreamEvent[] = [];
    const candidate = json.candidates?.[0];
    if (!candidate) return out;

    const content = candidate.content;
    if (!content?.parts?.length) return out;

    for (const part of content.parts) {
      if (part.type === 'text' && part.text) {
        out.push({ type: 'text.delta', text: part.text });
      }
      if (part.type === 'function_call' && part.functionCall?.name) {
        out.push({
          type: 'toolcall.args.delta',
          index: 0,
          fragment: '',
          name: part.functionCall.name,
        });
        if (part.functionCall.args) {
          out.push({
            type: 'toolcall.args.delta',
            index: 0,
            fragment: JSON.stringify(part.functionCall.args),
          });
        }
      }
    }

    // Usage metadata
    const usage = candidate.usageMetadata;
    if (usage) {
      out.push({
        type: 'usage',
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
          model: this.cfg.model,
        },
      });
    }

    return out;
  }
}
