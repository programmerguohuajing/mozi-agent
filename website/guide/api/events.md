---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c44561c8-a221-4cdf-9c3e-55f780186cb5'
  PropagateID: 'c44561c8-a221-4cdf-9c3e-55f780186cb5'
  ReservedCode1: 'f95678a9-5e56-4784-a1fe-f06631f48f70'
  ReservedCode2: 'f95678a9-5e56-4784-a1fe-f06631f48f70'
---

# API 参考 · Events & DTO（@mozi/shared）

`@mozi/shared` 是全仓零依赖契约包：事件、消息、配置、错误码。所有层（core / tools / providers / policy）只依赖它。

## AgentEvent 全集

事件流是墨子的「开放式神经系统」：引擎的全部行为都以事件产出（实时消费 + JSONL 落盘）。

### 会话

| 事件 | 载荷 |
|------|------|
| `session.started` | sessionId, config |
| `session.resumed` | replayedEvents |
| `session.terminated` | reason（user / error / shutdown） |

### 轮次与输出

| 事件 | 载荷 |
|------|------|
| `turn.started` | turnId, input |
| `message.delta` | text（流式增量） |
| `message.completed` | message: AssistantMessage |
| `turn.completed` | usage: TokenUsage, steps |

### 工具生命周期

| 事件 | 载荷 |
|------|------|
| `tool.requested` | call: ToolCall |
| `tool.approval.required` | call, reason: ApprovalReason（kind: risk / policy / …） |
| `tool.approval.resolved` | callId, decision, by（user / policy） |
| `tool.started` | callId |
| `tool.completed` | result: ToolResult（content / isError / display / meta.sandbox*） |

### 上下文

| 事件 | 载荷 |
|------|------|
| `context.compacted` | removedTurns, savedTokens, summary |

### 用量与终止

| 事件 | 载荷 |
|------|------|
| `token.usage` | usage |
| `task.completed` | reason: TaskCompleteReason |
| `error` | error: AgentError（code / message / recoverable） |

### 子智能体（M12）

`subagent.started / queued / progress / approval.required / completed / failed`

### MCP（M8）

`mcp.server.status`（disconnected → connecting → connected → degraded → offline）、
`mcp.sampling.requested / resolved`、`mcp.elicit.requested / resolved`

## 核心 DTO

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  model?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  riskLevel?: RiskLevel;   // read | meta | write | exec
}

interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
  display?: DisplayPayload;
  meta?: { sandboxLevel?; sandboxDegradedFrom?; sandboxNote?; errorKind? };
}

interface SessionConfig {
  models: { planner?: string; executor: string };
  policy: PolicyConfig;      // mode + rules
  sandbox: { level: 0 | 1 | 2 | 3 };
  context: { maxTokens?; autoCompactThreshold? };
  enabledTools: string[];    // '*' 或白名单
  limits?: Partial<SessionLimits>;
}
```

## ErrorCodes

稳定错误码常量（`ERR_PROVIDER_UNAVAILABLE` / `ERR_TOOL_TIMEOUT` / `ERR_SESSION_BUSY` / …），
宿主可按 code 做恢复策略（`MoziError.recoverable` 标记是否可续跑）。

> AI生成