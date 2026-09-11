---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '79884963-8d77-48aa-a544-1150b3c6a79c'
  PropagateID: '79884963-8d77-48aa-a544-1150b3c6a79c'
  ReservedCode1: 'b27ea884-fcbd-4f4f-bb3e-94ba0177e5b6'
  ReservedCode2: 'b27ea884-fcbd-4f4f-bb3e-94ba0177e5b6'
---

# API 参考 · Engine（@mozi/core）

`@mozi/core` 导出引擎全部公开能力。`import { ... } from '@mozi/core'`。

## createEngine(opts): AgentEngine

同步工厂：组装 providers / tools / policy / context / sessions / workspace。

```ts
interface CreateEngineOptions {
  sessionDir: string;             // 会话落盘目录
  workspaceRoot: string;          // 文件操作被约束在此目录
  providers: ProviderRegistry;    // 模型注册表
  approval?: ApprovalGateway;     // 审批网关（默认 InteractiveApprovalGateway）
  policyMode?: PolicyMode;        // readonly | auto | full-auto
  systemPrompt?: string;          // 覆盖基座提示词（P0 层）
  sandboxLevel?: 0 | 1 | 2 | 3;   // 启用沙箱（不传则不启用）
  allowNet?: string[];            // 沙箱网络白名单（域名）
  mcpServers?: McpServerEntry[];  // MCP 配置（需 createEngineAsync）
  onMcpEvent?: (e: AgentEvent) => void;
  subagent?: Partial<SubAgentConfig>;
  enableSubAgents?: boolean;      // 默认 true
  onEvent?: (e: AgentEvent) => void; // 宿主级实时事件出口
}
```

## createEngineAsync(opts): Promise\<CreatedEngine\>

连接 MCP server 后返回 `{ engine, mcp?, supervisor, dispose() }`。

## AgentEngine

| 成员 | 说明 |
|------|------|
| `run(input): AsyncGenerator<AgentEvent>` | 主循环入口（核心） |
| `abort(sessionId, reason?)` | 中断会话（子智能体树级联取消） |
| `resolveApproval(sessionId, callId, decision)` | 裁决挂起的审批 |
| `getSnapshot(sessionId): SessionSnapshot` | 会话快照（state / steps / usage） |
| `setHostEventSink(sink)` | 宿主级实时事件出口（子智能体桥接依赖它） |
| `workspaceRoot: Workspace` | 引擎持有的工作区 |
| `subAgentSupervisor?: SubAgentSupervisor` | 子智能体监督者 |

```ts
interface RunInput {
  sessionId: string;
  text: string;
  overrides?: Partial<SessionConfig>;  // 每次运行可覆盖模型/策略/限制
  signal?: AbortSignal;                // 外部中断
}
```

## SessionStore

| 成员 | 说明 |
|------|------|
| `loadOrCreate(id, config?)` | 加载或创建会话 |
| `fork(srcId, atEventIndex?, newId?)` | 分支会话（复制前 N 条事件） |
| `gc(retentionDays = 30)` | 过期会话移入 `.trash` |
| `restore(id)` / `listTrashed()` | 从回收站恢复 |

## ContextManager

上下文分层组装：P0 基座提示词 / P1 AGENTS.md 注入 / 历史（含新鲜度脏文件提示）/ 工具定义。
Auto-Compact 由引擎在每步前评估（阈值见配置手册）。

## 审批网关

- `InteractiveApprovalGateway`：挂起等待 `resolve(callId, 'allow' | 'deny')`
- `autoApproveGateway(decision)`：统一裁决（CI / 评测 / 服务端）

## 其他导出

`Workspace`（工作区，含原子写）、`createBuiltinRegistry()`（内置工具集）、
`SubAgentSupervisor`、`AgentTemplate` 与内置模板（explore / general / reviewer）、
`FreshnessTracker`、压缩器工具函数、`defaultConfig(executor?)`。

> AI生成