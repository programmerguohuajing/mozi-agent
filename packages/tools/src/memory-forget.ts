/**
 * memory_forget：删除记忆条目（M16 §16.4）。riskLevel = write（用户指令驱动）。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';

interface MemoryForgetInput {
  id: string;
}

export const memoryForgetTool: AgentTool<MemoryForgetInput> = {
  name: 'memory_forget',
  version: '1.0.0',
  riskLevel: 'write',
  description: [
    'Delete a stored memory entry by id (use memory_search first to find the id). Only call this when the',
    'user asks to forget something or when a stored memory is verifiably wrong.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Memory entry id to delete.' } },
    required: ['id'],
  },
  async execute(input: MemoryForgetInput, ctx: ToolContext) {
    if (!ctx.memory) {
      return fail('memory backend is not available in this session', 'no-memory');
    }
    const id = (input.id ?? '').trim();
    if (!id) return fail('id must be a non-empty string', 'bad-args');
    return ctx.memory.forget(id)
      ? ok(`<memory forgotten id="${id}">`)
      : fail(`no memory entry with id "${id}"`, 'not-found');
  },
};
