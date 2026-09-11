// embed-minimal —— 用约 50 行代码把墨子引擎嵌进你自己的程序。
// 运行：pnpm build && pnpm --filter @mozi/example-embed-minimal start
// （默认用 ScriptedProvider 零成本演示；设 OPENAI_API_KEY 可切真实模型，见文末注释。）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '@mozi/core';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';

// 1) 准备一个工作区（引擎的一切读写都被限制在这里）
const workspaceRoot = join(tmpdir(), `mozi-embed-${Date.now()}`);
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, 'hello.txt'), 'mozi engine, embedded.');

// 2) 注册一个模型 Provider。ScriptedProvider 是确定性回放（零 API 成本）；
//    生产环境换成 OpenAICompatibleProvider（见本文件末尾注释）。
const providers = new ProviderRegistry().register(
  new ScriptedProvider(
    [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'hello.txt' } }] },
      { content: 'hello.txt 共 22 个字符，内容以 "mozi engine" 开头。' },
    ],
    'scripted',
  ),
);
// 引擎默认 executor 模型名是 deepseek-chat —— 用别名把它指向我们的 provider。
providers.alias('deepseek-chat', 'scripted').alias('executor', 'scripted');

// 3) 组装引擎：会话目录 + 工作区 + providers，一步到位
const engine = createEngine({
  sessionDir: join(workspaceRoot, '.sessions'),
  workspaceRoot,
  providers,
  policyMode: 'auto', // readonly | auto | full-auto
});

// 4) 跑一个任务：事件流式产出，会话自动落盘（JSONL 可回放）
for await (const event of engine.run({
  sessionId: 'embed-demo',
  text: '读取 hello.txt 并报告它的内容长度',
})) {
  if (event.type === 'message.completed' && event.message.content)
    console.log(`[assistant] ${event.message.content}`);
  else if (event.type === 'tool.completed')
    console.log(`[tool:${event.result.isError ? 'fail' : 'ok'}] ${event.result.content.slice(0, 60)}`);
  else if (event.type === 'turn.completed')
    console.log(`[done] steps=${event.steps} tokens=${event.usage.totalTokens}`);
  else if (event.type === 'error') console.error(`[error] ${event.error.code}: ${event.error.message}`);
}

// 产出物都在 workspaceRoot 下：文件变更 + .sessions/*.jsonl（事件流全量记录）。
//
// 切换真实模型（OpenAI 兼容端点，DeepSeek/Qwen/GLM/Ollama 均可）：
//   import { OpenAICompatibleProvider } from '@mozi/providers';
//   new ProviderRegistry().register(new OpenAICompatibleProvider({
//     baseUrl: 'https://api.deepseek.com/v1',
//     apiKey: () => process.env.DEEPSEEK_API_KEY,
//     model: 'deepseek-chat',
//   }));
