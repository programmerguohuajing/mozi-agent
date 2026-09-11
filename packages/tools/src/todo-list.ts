/**
 * todo_list：会话级任务清单（M2 §3.3.7）。
 * 引擎维护 session.meta.todos，模型据此拆解 >5 步的任务并逐项更新。
 * riskLevel = meta（无副作用，仅操作内存态）。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';

export interface TodoTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  detail?: string;
}

interface TodoInput {
  operation: 'list' | 'update';
  tasks?: TodoTask[];
}

const STATUS_BOX: Record<TodoTask['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
};

export function renderTodos(tasks: TodoTask[]): string {
  if (tasks.length === 0) return '(todo list is empty)';
  return tasks
    .map((t, i) => {
      const detail = t.detail ? ` — ${t.detail}` : '';
      return `${STATUS_BOX[t.status] ?? '[ ]'} ${i + 1}. ${t.title}${detail}`;
    })
    .join('\n');
}

function readTodos(ctx: ToolContext): TodoTask[] {
  const meta = ctx.session?.meta as { todos?: TodoTask[] } | undefined;
  return Array.isArray(meta?.todos) ? meta.todos : [];
}

function writeTodos(ctx: ToolContext, tasks: TodoTask[]): void {
  if (!ctx.session) return;
  ctx.session.meta.todos = tasks;
}

function normalize(tasks: TodoTask[]): TodoTask[] {
  const seen = new Set<string>();
  return tasks.map((t, i) => {
    let id = t.id || `t${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const status: TodoTask['status'] =
      t.status === 'in_progress' || t.status === 'done' ? t.status : 'pending';
    return { id, title: t.title, status, ...(t.detail ? { detail: t.detail } : {}) };
  });
}

export const todoListTool: AgentTool<TodoInput> = {
  name: 'todo_list',
  version: '1.0.0',
  riskLevel: 'meta',
  description: [
    'Create or update the session todo list. Use this for any task with more than 5 steps:',
    'first record the plan as tasks, then mark each one in_progress when you start and done when you finish.',
    'operation="update" replaces the whole list with the provided tasks array (keep completed items with',
    'status="done" so progress is visible). operation="list" returns the current list without changes.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'update'],
        description: 'list: read current todos; update: replace the list with `tasks`.',
      },
      tasks: {
        type: 'array',
        description: 'Required when operation="update". Full todo list after this update.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id, e.g. "1" or "fix-login".' },
            title: { type: 'string', description: 'Short imperative description.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            detail: { type: 'string', description: 'Optional extra context.' },
          },
          required: ['id', 'title', 'status'],
        },
      },
    },
    required: ['operation'],
  },
  async execute(input: TodoInput, ctx: ToolContext) {
    if ([ 'list', 'update' ].indexOf(input.operation) === -1) {
      return fail(`invalid operation: ${String(input.operation)} (expected list|update)`, 'bad-args');
    }
    if (input.operation === 'list') {
      return ok(`<todo_list>\n${renderTodos(readTodos(ctx))}\n</todo_list>`);
    }
    if (!Array.isArray(input.tasks)) {
      return fail('operation="update" requires a `tasks` array', 'bad-args');
    }
    const tasks = normalize(input.tasks);
    writeTodos(ctx, tasks);
    const done = tasks.filter((t) => t.status === 'done').length;
    return ok(
      `<todo_list updated ${done}/${tasks.length} done>\n${renderTodos(tasks)}\n</todo_list>`,
    );
  },
};
