/**
 * 流式聚合器（M4 §4.3）：各家 provider 把原生 chunk 转成增量事件喂给 Aggregator，
 * Aggregator 把 toolcall.args.delta 按 index 拼成完整 JSON，结束时生成 AssistantMessage。
 */
import type { AssistantMessage, RiskLevel, ToolCall } from '@mozi/shared';
import { safeParseJson } from './json.js';
import type { StreamEvent } from './types.js';

export class StreamAggregator {
  private buffers = new Map<number, string>();
  private names = new Map<number, string>();
  private text: string[] = [];
  private reasoning: string[] = [];

  feed(ev: StreamEvent): void {
    if (ev.type === 'text.delta') this.text.push(ev.text);
    else if (ev.type === 'reasoning.delta') this.reasoning.push(ev.text);
    else if (ev.type === 'toolcall.args.delta') {
      const frag = ev.fragment ?? '';
      if (ev.name?.length) this.names.set(ev.index, ev.name);
      const prev = this.buffers.get(ev.index) ?? '';
      this.buffers.set(ev.index, prev + frag);
    }
  }

  finish(riskResolver?: (name: string) => RiskLevel): AssistantMessage {
    const toolCalls: ToolCall[] = [];
    const indices = [...this.buffers.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const raw = this.buffers.get(index) ?? '';
      const name = this.names.get(index) ?? `tool_${index}`;
      toolCalls.push({
        id: `tc_${index}`,
        name,
        arguments: safeParseJson(raw),
        riskLevel: riskResolver ? riskResolver(name) : 'read',
      });
    }
    return {
      role: 'assistant',
      content: this.text.join('') || null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      reasoning: this.reasoning.join('') || undefined,
    };
  }
}

/** 把文本切成若干小片段，模拟流式输出（测试用）。 */
export function chunkText(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}
