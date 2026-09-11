// custom-tool —— 给墨子引擎加一个你自己的工具（word_count）。
// 运行：pnpm build && pnpm --filter @mozi/example-custom-tool start
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine, ContextManager, SessionStore } from '@mozi/core';
import { PolicyEngine } from '@mozi/policy';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import { Workspace, createBuiltinRegistry, ok } from '@mozi/tools';

// ---------- 1) 定义自定义工具：实现 AgentTool 契约 ----------

const wordCountTool = {
  name: 'word_count',
  version: '1.0.0',
  description: '统计工作区内一个文本文件的字符数、单词数与行数。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
    },
    required: ['path'],
  },
  riskLevel: 'read', // 只读工具：引擎会把它与其它读操作并行调度
  /**
   * @param {{ path: string }} input
   * @param {import('@mozi/tools').ToolContext} ctx
   */
  async execute(input, ctx) {
    const abs = ctx.workspace.resolve(input.path);
    const text = await ctx.workspace.readFile(abs);
    const chars = text.length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split('\n').length;
    return ok(JSON.stringify({ path: input.path, chars, words, lines }));
  },
};

// ---------- 2) 准备工作区与一段会用到该工具的任务 ----------

const workspaceRoot = join(tmpdir(), `mozi-custom-tool-${Date.now()}`);
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, 'notes.md'), 'mozi tools are extensible.\nany capability, one object.');

// ---------- 3) 手工组装引擎（factory 的透明版）：注册表可完全自定义 ----------

const tools = createBuiltinRegistry(); // 内置：read/write/edit/glob/grep/shell/todo/task
tools.register(wordCountTool); // 加上我们的

const providers = new ProviderRegistry().register(
  new ScriptedProvider(
    [
      { toolCalls: [{ name: 'word_count', arguments: { path: 'notes.md' } }] },
      { content: 'notes.md：48 字符 / 8 个单词 / 2 行。' },
    ],
    'scripted',
  ),
);
providers.alias('deepseek-chat', 'scripted').alias('executor', 'scripted');

const engine = new AgentEngine({
  providers,
  tools,
  policy: new PolicyEngine(),
  context: new ContextManager({ workspaceRoot }),
  sessions: new SessionStore(join(workspaceRoot, '.sessions')),
  workspace: new Workspace(workspaceRoot),
  policyMode: 'auto',
});

// ---------- 4) 跑起来 ----------

for await (const event of engine.run({
  sessionId: 'custom-tool-demo',
  text: '统计 notes.md 的规模',
})) {
  if (event.type === 'tool.completed' && !event.result.isError) {
    console.log(`[word_count] ${event.result.content}`);
  } else if (event.type === 'message.completed' && event.message.content) {
    console.log(`[assistant] ${event.message.content}`);
  } else if (event.type === 'error') {
    console.error(`[error] ${event.error.code}: ${event.error.message}`);
  }
}

// 关键点：
// - riskLevel: 'read' 参与「读并行 / 写串行」调度；'exec' 则强制串行并可能触发审批
// - execute 拿到 ToolContext：workspace / signal(可中止) / sessionId / session.meta(会话级状态)
// - 参数 schema 用 JSON Schema，引擎会把工具清单发给模型自行决策调用
// - ok() / fail() 是结果构造辅助（@mozi/tools 导出）
