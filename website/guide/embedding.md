---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a3bfe0b1-157a-44be-a8ba-e204345833b7'
  PropagateID: 'a3bfe0b1-157a-44be-a8ba-e204345833b7'
  ReservedCode1: '2fe646d4-ae25-4c4e-aef5-149952404936'
  ReservedCode2: '2fe646d4-ae25-4c4e-aef5-149952404936'
---

# 引擎嵌入指南

`@mozi/core` 是独立 npm 包：零 UI 依赖、Node ≥ 20、可直接嵌入你自己的服务、脚本、编辑器插件或机器人。

## 两种组装方式

### 方式一：createEngine 工厂（推荐）

```ts
import { createEngine, createEngineAsync } from '@mozi/core';
import { OpenAICompatibleProvider, ProviderRegistry } from '@mozi/providers';

const providers = new ProviderRegistry().register(
  new OpenAICompatibleProvider({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: () => process.env.DEEPSEEK_API_KEY!, // 密钥只走环境变量
    model: 'deepseek-chat',
  }),
);

const engine = createEngine({
  sessionDir: './.my-app/sessions',   // 会话 JSONL 落盘目录（自动创建）
  workspaceRoot: process.cwd(),       // 引擎的一切文件读写都被限制在此目录
  providers,
  policyMode: 'auto',                 // readonly | auto | full-auto
  // 可选：
  // sandboxLevel: 2,                 // 启用四级沙箱
  // allowNet: ['registry.npmjs.org'],
  // mcpServers: [...],               // 需用 createEngineAsync（MCP 连接是异步的）
  // subagent: { maxConcurrent: 3 },
  // onEvent: (e) => {},              // 宿主级实时事件出口（含子智能体桥接）
});

for await (const event of engine.run({ sessionId: 's1', text: '跑一下测试' })) {
  // 见「Events & DTO」API 参考
}
```

### 方式二：手工组装（完全控制）

需要自定义工具注册表、策略引擎或上下文管理器时：

```ts
import { AgentEngine, ContextManager, SessionStore } from '@mozi/core';
import { PolicyEngine } from '@mozi/policy';
import { Workspace, createBuiltinRegistry } from '@mozi/tools';

const tools = createBuiltinRegistry();
tools.register(myCustomTool);        // 注入自定义工具

const engine = new AgentEngine({
  providers,                          // ProviderRegistry
  tools,                              // ToolRegistry（完全自定义）
  policy: new PolicyEngine(),
  context: new ContextManager({ workspaceRoot, systemPrompt }),
  sessions: new SessionStore(sessionDir),
  workspace: new Workspace(workspaceRoot),
  policyMode: 'auto',
});
```

## 事件流消费

`engine.run()` 是异步生成器，逐个产出 `AgentEvent`。核心事件：

| 事件 | 时机 |
|------|------|
| `turn.started` / `turn.completed` | 一轮任务首尾（completed 带 steps 与 TokenUsage） |
| `message.delta` / `message.completed` | 流式输出与整条 assistant 消息 |
| `tool.requested` → `tool.started` → `tool.completed` | 工具生命周期 |
| `tool.approval.required` / `tool.approval.resolved` | 审批（见下） |
| `context.compacted` | Auto-Compact 触发（removedTurns / savedTokens / summary） |
| `subagent.*` | 子智能体编排（started/queued/progress/completed/failed） |
| `mcp.server.status` 等 | MCP 状态与反向请求 |
| `task.completed` | 终止原因（model_finished / max_steps_exceeded / …） |
| `error` | 错误（带 code 与 recoverable） |

## 审批集成

引擎不假设 UI。默认 `InteractiveApprovalGateway` 挂起等待外部裁决；你的宿主有两种接法：

```ts
// 1) 自动裁决（服务端 / 评测 / CI）
import { autoApproveGateway } from '@mozi/core';
createEngine({ approval: autoApproveGateway('allow'), policyMode: 'full-auto', ... });

// 2) 自定义交互（把审批卡片渲染到你的 UI）
const gateway = new InteractiveApprovalGateway();
createEngine({ approval: gateway, ... });
// 收到 tool.approval.required 事件后：
gateway.resolve(callId, 'allow'); // 或 'deny'
```

## 中断与快照

```ts
engine.abort(sessionId, 'user_interrupt'); // 中断（子智能体树级联取消）

engine.getSnapshot(sessionId);             // { state, currentStep, usage, ... }
```

## 会话持久化

- 每个会话落盘为 `events.jsonl` + `meta.json`（单一事实源，可 resume / 回放 / fork）
- `SessionStore` 提供 `fork(srcId, atEventIndex?)`（分支）、`gc(retentionDays)`（回收）、`restore(id)`
- `.mozi/snapshots/<sessionId>` 存编辑快照（`/undo` 依赖它，已 gitignore）

## 真实示例

- `examples/embed-minimal/` —— 50 行：工厂组装 + 事件消费 + ScriptedProvider
- `examples/custom-tool/` —— 手工组装 + 自定义工具 + 注册表控制
- `benchmark/runner/run.mjs` —— 生产级用法：无人值守评测（自动审批 + 事件统计 + 超时控制）

> AI生成