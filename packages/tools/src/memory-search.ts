/**
 * memory_search：模型主动回忆（M16 §16.4）。riskLevel = read。
 * 不确定的既存记忆先查证，避免臆写。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';

interface MemorySearchInput {
  query: string;
  layer?: 'user' | 'project' | 'semantic';
  limit?: number;
}

export const memorySearchTool: AgentTool<MemorySearchInput> = {
  name: 'memory_search',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Search previously stored memories (user preferences, project conventions, past decisions) before',
    'assuming something is unknown or writing a new memory. Returns the best keyword matches with their',
    'layer and type. Use this to verify an existing fact rather than guessing or duplicating it.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      layer: {
        type: 'string',
        enum: ['user', 'project', 'semantic'],
        description: 'Optional: restrict to one memory layer.',
      },
      limit: { type: 'integer', description: 'Max results (default 5).' },
    },
    required: ['query'],
  },
  async execute(input: MemorySearchInput, ctx: ToolContext) {
    if (!ctx.memory) {
      return fail('memory backend is not available in this session', 'no-memory');
    }
    const query = (input.query ?? '').trim();
    if (!query) return fail('query must be a non-empty string', 'bad-args');
    const hits = ctx.memory.search(query, {
      ...(input.layer ? { layer: input.layer } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    if (!hits.length) return ok(`<memories query="${query}">\n(none)\n</memories>`);
    const lines = hits.map(
      (h) => `- [${h.entry.type}] (${h.entry.layer}/${h.entry.source}) ${h.entry.content}`,
    );
    return ok(`<memories query="${query}">\n${lines.join('\n')}\n</memories>`);
  },
};
