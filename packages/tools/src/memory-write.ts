/**
 * memory_write：显式写入记忆（M16 §16.4）。
 * riskLevel = write（记忆写走审批，默认 auto 放行）。
 *
 * 描述词明确：只在用户明确要求或高置信事实时写；不确定的事实用 memory_search 查证而非臆写。
 * 内容经 SecretMasker 过滤（§16.5）：检测到密钥/token → 拒写。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';

interface MemoryWriteInput {
  layer: 'user' | 'project';
  type: 'fact' | 'preference' | 'decision';
  content: string;
  evidence?: string;
}

export const memoryWriteTool: AgentTool<MemoryWriteInput> = {
  name: 'memory_write',
  version: '1.0.0',
  riskLevel: 'write',
  description: [
    'Persist a durable memory across sessions. Write ONLY when the user explicitly asks you to',
    'remember something, or when the fact is high-confidence and clearly reusable (project conventions,',
    'build/test commands, settled decisions). For uncertain facts, use memory_search to verify instead of writing.',
    'layer="user" is global preference (language/style/habits); layer="project" is repo-specific',
    '(conventions, commands, known pitfalls, team decisions). Content is deduplicated and merged with',
    'similar existing entries. Never write secrets, tokens or credentials — such writes are rejected.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      layer: {
        type: 'string',
        enum: ['user', 'project'],
        description: 'user: global preference; project: workspace-specific facts and conventions.',
      },
      type: { type: 'string', enum: ['fact', 'preference', 'decision'] },
      content: {
        type: 'string',
        description: 'A single, atomic, verifiable statement. Do not include secrets or credentials.',
      },
      evidence: {
        type: 'string',
        description: 'Optional pointer to where this came from (file:line, or session id).',
      },
    },
    required: ['layer', 'type', 'content'],
  },
  async execute(input: MemoryWriteInput, ctx: ToolContext) {
    if (!ctx.memory) {
      return fail('memory backend is not available in this session', 'no-memory');
    }
    if (input.layer !== 'user' && input.layer !== 'project') {
      return fail('layer must be "user" or "project"', 'bad-args');
    }
    if (!['fact', 'preference', 'decision'].includes(input.type)) {
      return fail('type must be fact|preference|decision', 'bad-args');
    }
    const content = (input.content ?? '').trim();
    if (!content) return fail('content must be a non-empty string', 'bad-args');
    try {
      const res = ctx.memory.write({
        layer: input.layer,
        type: input.type,
        content,
        ...(input.evidence ? { evidence: input.evidence } : {}),
      });
      const lines = [
        res.merged
          ? `<memory written (merged into ${res.entry.id})>`
          : `<memory written (${res.entry.id})>`,
        content,
      ];
      if (res.replaced) lines.push(`(replaced previous: ${res.replaced})`);
      return ok(lines.join('\n'));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), 'memory-rejected');
    }
  },
};
