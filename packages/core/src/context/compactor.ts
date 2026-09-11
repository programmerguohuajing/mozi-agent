/**
 * 上下文压缩与 token 估算（M2 / 详细设计 §5.4）。
 * Auto-Compact 流程：触发条件（估算用量 / 预算 ≥ 阈值，且距上次压缩 ≥ minIntervalTurns）
 * → 选压缩区（最早 40% 轮次，至少保留最近 5 条消息）
 * → 调模型生成结构化摘要 → 历史区替换为一条摘要消息。
 * 失败不阻塞任务：压缩调用失败则跳过，下次触发时重试。
 */
import type { LLMProvider } from '@mozi/providers';
import type { ChatMessage } from '@mozi/shared';

/** 轻量 token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token，取混合加权。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4) + 1;
}

export function estimateMessageTokens(msg: ChatMessage): number {
  if (msg.role === 'user') {
    return msg.content.reduce((n, part) => n + (part.type === 'text' ? estimateTokens(part.text) : 800), 0);
  }
  if (msg.role === 'assistant') {
    let n = estimateTokens(msg.content ?? '');
    if (msg.toolCalls) {
      for (const c of msg.toolCalls) n += estimateTokens(JSON.stringify(c.arguments ?? '')) + 40;
    }
    return n;
  }
  return estimateTokens(msg.content);
}

export interface CompactTriggerCheck {
  should: boolean;
  reason?: string;
}

export interface CompactOptions {
  /** 上下文 token 预算（默认 128k） */
  budgetTokens: number;
  /** 触发阈值 usage/budget（默认 0.8） */
  threshold: number;
  /** 距上次压缩的最小轮数（默认 3，防频繁压缩） */
  minIntervalTurns: number;
  /** 距上次压缩已发生的轮数 */
  turnsSinceLastCompact: number;
}

export function shouldCompact(
  messages: ChatMessage[],
  opts: CompactOptions,
): CompactTriggerCheck {
  const total = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  if (total / opts.budgetTokens < opts.threshold) {
    return { should: false };
  }
  // turnsSinceLastCompact < 0 表示「从未压缩过」：首次压缩不受最小间隔约束（§5.4）。
  if (opts.turnsSinceLastCompact >= 0 && opts.turnsSinceLastCompact < opts.minIntervalTurns) {
    return { should: false, reason: 'min-interval' };
  }
  return { should: true };
}

/** 压缩区选择：最早的 40% 条消息（偶数对齐保证 user/tool 配对完整），至少保留最近 5 条。 */
export function selectCompactRegion(messages: ChatMessage[]): {
  compact: ChatMessage[];
  keep: ChatMessage[];
} {
  if (messages.length <= 5) return { compact: [], keep: messages };
  const cut = Math.max(1, Math.floor(messages.length * 0.4));
  // 对齐到偶数边界，避免把 tool 消息与其 assistant 调用拆开
  const aligned = cut % 2 === 0 ? cut : cut + 1;
  const safeCut = Math.min(aligned, messages.length - 5);
  if (safeCut < 1) return { compact: [], keep: messages };
  return {
    compact: messages.slice(0, safeCut),
    keep: messages.slice(safeCut),
  };
}

const COMPACT_PROMPT = `请把以下历史对话压缩为结构化摘要，字段：task / done[] / pending[] / keyFiles[] / keyDecisions[] / openQuestions[]。
不要遗漏任何未完成的工具调用与待办。直接输出摘要正文。`;

/** 压缩模型调用：返回摘要文本。失败抛错（调用方决定跳过）。 */
export async function summarize(
  provider: LLMProvider,
  region: ChatMessage[],
  sessionId?: string,
): Promise<string> {
  const transcript = region
    .map((m) => {
      if (m.role === 'user') {
        const text = m.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
        return `[user] ${text}`;
      }
      if (m.role === 'assistant') {
        const calls = m.toolCalls?.map((c) => ` [调用 ${c.name}]`).join('') ?? '';
        return `[assistant] ${m.content ?? ''}${calls}`;
      }
      if (m.role === 'tool') return `[tool ${m.callId}] ${m.content.slice(0, 300)}`;
      return `[system] ${m.content}`;
    })
    .join('\n');

  const stream = provider.chat({
    messages: [
      { role: 'system', content: '你是会话压缩助手，只输出结构化摘要。' },
      { role: 'user', content: [{ type: 'text', text: `${COMPACT_PROMPT}\n\n${transcript}` }] },
    ],
    maxOutputTokens: 2000,
    sessionId,
  });
  for await (const _ of stream) {
    /* 消费流 */
  }
  const reply = stream.result();
  return reply.content ?? '';
}

/** 执行压缩：返回新的消息数组与事件数据；摘要失败返回 null（跳过本次压缩）。 */
export async function compactMessages(
  messages: ChatMessage[],
  provider: LLMProvider,
  sessionId?: string,
): Promise<{ messages: ChatMessage[]; removedTurns: number; savedTokens: number; summary: string } | null> {
  const { compact, keep } = selectCompactRegion(messages);
  if (compact.length === 0) return null;
  try {
    const summary = await summarize(provider, compact, sessionId);
    if (!summary.trim()) return null;
    const before = compact.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const after = estimateTokens(summary);
    const summaryMsg: ChatMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<context-summary>\n${summary}\n</context-summary>\n（以上为早期对话的压缩摘要，完整历史可从事件日志回放。）`,
        },
      ],
    };
    return {
      messages: [summaryMsg, ...keep],
      removedTurns: compact.length,
      savedTokens: Math.max(0, before - after),
      summary,
    };
  } catch {
    return null; // 压缩失败不阻塞任务，下次触发重试
  }
}
