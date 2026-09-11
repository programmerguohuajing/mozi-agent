---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '38524117-2553-41f2-b3da-6fe0f6e2c22f'
  PropagateID: '38524117-2553-41f2-b3da-6fe0f6e2c22f'
  ReservedCode1: '5e0a7579-7f34-479a-ad4c-8a7d77ca9cc6'
  ReservedCode2: '5e0a7579-7f34-479a-ad4c-8a7d77ca9cc6'
---

# API 参考 · Providers（@mozi/providers）

## ProviderRegistry

| 成员 | 说明 |
|------|------|
| `register(provider)` | 按 `provider.id` 注册 |
| `alias(alias, modelId)` | 模型别名（引擎默认 executor 是 `deepseek-chat`，用别名指向你的 provider） |
| `resolve(modelId)` | 解析 provider（未注册抛 `ERR_PROVIDER_UNAVAILABLE`） |
| `list()` | 已注册清单 |

## LLMProvider 契约

```ts
interface LLMProvider {
  readonly id: string;
  chat(req: ChatRequest): LLMStream;   // 流式
  capabilities(): ProviderCapabilities;
}

interface ProviderCapabilities {
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContextTokens: number;
  streamingToolArgs: boolean;
  systemPromptAsSeparateField: boolean;
}
```

## 内置适配器

| 适配器 | 覆盖 |
|--------|------|
| `OpenAICompatibleProvider` | DeepSeek / Qwen / GLM / Ollama / vLLM 等任意 OpenAI 兼容端点（fetch + 手写 SSE，零 SDK 依赖） |
| `OpenAIResponsesProvider` | OpenAI Responses API |
| `AnthropicProvider` | Claude 原生协议 |
| `GeminiProvider` | Gemini 原生协议 |
| `ScriptedProvider` | 确定性回放（测试基建，零 API 成本） |

```ts
new OpenAICompatibleProvider({
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: () => process.env.DEEPSEEK_API_KEY!,  // 密钥只走环境变量
  model: 'deepseek-chat',
});
```

## ScriptedProvider（测试关键）

录制「逐轮响应序列」离线回放，所有 loop 行为（审批 / 中断 / 压缩 / 步数上限 / 重试）
都能写成确定性集成测试：

```ts
const provider = new ScriptedProvider([
  { toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] },
  { toolCalls: [{ name: 'edit_file', arguments: { patch: '*** Begin Patch...' } }] },
  { content: '已完成修改' },
]);
// 多会话：setScenarios({ 'sub-*': [...], '*': [...] })
```

## StreamAggregator

流式分片聚合：toolcall 参数按 index 拼装 + 容错（各家模型 tool-calling 分片抖动的统一处理）。

> AI生成