/**
 * task：派发子智能体执行子任务（M12 §12.4）。
 * riskLevel = meta：自身无副作用，子 Agent 内部的工具调用受子策略管控。
 * 具体派发由 core 的 SubAgentSupervisor 实现（ToolContext.supervisor）。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';

interface TaskInput {
  agent: string;
  prompt: string;
  contextFiles?: string[];
  timeoutMs?: number;
}

export const taskTool: AgentTool<TaskInput> = {
  name: 'task',
  version: '1.0.0',
  riskLevel: 'meta',
  description: [
    'Dispatch a sub-agent to perform a subtask in an isolated context; only its conclusion comes back to you.',
    'When to use: (1) you need to read/search a large amount of code but only need the conclusion (use explore)',
    'to protect your own context; (2) multiple independent subtasks (issue several task calls, the engine runs',
    'them in parallel); (3) you need a specialised role (reviewer, or a custom template).',
    'When NOT to use: reading a single file or a quick grep (use read_file/grep directly); the subtask depends on',
    'your current reasoning (the sub-agent cannot see this conversation).',
    'Rules: the prompt must be self-contained (the sub-agent sees only your prompt + the workspace).',
    'Ask it to return a structured summary of "conclusion + relevant file:line".',
    'Sub-agents with a readonly template cannot modify files.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description:
          "Template name: 'explore' | 'general' | 'reviewer' | a custom template from .mozi/agents/*.md.",
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained instruction for the sub-agent (it cannot see this conversation).',
      },
      contextFiles: {
        type: 'array',
        description:
          'Optional files whose contents are pre-injected into the sub-agent (each truncated to 2k).',
        items: { type: 'string' },
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional override for the template timeout (max 600000).',
      },
    },
    required: ['agent', 'prompt'],
  },
  async execute(input: TaskInput, ctx: ToolContext) {
    if (!ctx.supervisor) {
      return fail(
        'task tool is not available in this session (no sub-agent supervisor injected)',
        'unsupported',
      );
    }
    if (!input.agent || !input.prompt) {
      return fail('task requires both `agent` and `prompt`', 'bad-args');
    }
    return ctx.supervisor.dispatch(
      {
        agent: input.agent,
        prompt: input.prompt,
        contextFiles: input.contextFiles,
        timeoutMs: input.timeoutMs,
      },
      ctx,
    );
  },
};

/** 供 registry / 描述拼装复用的占位导出（无副作用）。 */
export const TASK_TOOL_NAME = 'task';
export { ok };
