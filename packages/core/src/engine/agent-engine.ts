import type { PolicyEngine } from '@mozi/policy';
import type { EvaluateOptions } from '@mozi/policy';
import type { ProviderRegistry } from '@mozi/providers';
/**
 * AgentEngine：状态机主循环（M1 §1.5 + M2 扩展）。
 * 编排：上下文组装（含新鲜度/Auto-Compact）→ 模型推理（流式）→ 策略裁决 → 工具执行（读并行 / 写串行）
 *      → 回填 → 续跑。含中断（AbortSignal）、失败归一化、会话落盘可回放、子智能体派发（M12）。
 */
import {
  type AgentError,
  type AgentEvent,
  type AssistantMessage,
  ErrorCodes,
  MoziError,
  type PolicyMode,
  type RunInput,
  type SandboxRunner,
  type SessionConfig,
  type SessionSnapshot,
  type TokenUsage,
  type ToolCall,
  type ToolResult,
  toMoziError,
} from '@mozi/shared';
import type { MemoryAccess, ToolRegistry, VisionAccess, Workspace } from '@mozi/tools';
import type { MemoryManager } from '../memory/manager.js';
import type { HookRunner, HookPayload } from '../hooks/runner.js';
import type { HookEvent, HookOutcome, ResolvedHook } from '../hooks/types.js';
import { compactMessages, shouldCompact } from '../context/compactor.js';
import { FreshnessTracker } from '../context/freshness.js';
import type { ContextManager, BuildView } from '../context/context-manager.js';
import type { Session, SessionStore } from '../session/session-store.js';
import type { SubAgentSupervisor } from '../subagent/supervisor.js';
import { type ApprovalGateway, InteractiveApprovalGateway } from './approve.js';

function now(): string {
  return new Date().toISOString();
}

function genId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function mergeUsage(base: TokenUsage, add: TokenUsage): TokenUsage {
  return {
    inputTokens: base.inputTokens + add.inputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    totalTokens: base.totalTokens + add.totalTokens,
    costUsd: (base.costUsd ?? 0) + (add.costUsd ?? 0),
    model: add.model || base.model,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new MoziError(ErrorCodes.ERR_TOOL_TIMEOUT, 'tool aborted', true));
      return;
    }
    const timer = setTimeout(() => {
      reject(new MoziError(ErrorCodes.ERR_TOOL_TIMEOUT, `tool timed out after ${ms}ms`, true));
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new MoziError(ErrorCodes.ERR_TOOL_TIMEOUT, 'tool aborted', true));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** 会读取文件内容的工具（用于新鲜度基准标记）。 */
const READ_FILE_TOOLS = new Set(['read_file', 'edit_file']);

export interface EngineDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  policy: PolicyEngine;
  context: ContextManager;
  sessions: SessionStore;
  workspace: Workspace;
  approval?: ApprovalGateway;
  policyMode?: PolicyMode;
  /** 可选沙箱执行器（M6 §6.4）：注入后 shell 工具经此通道执行命令。 */
  sandbox?: SandboxRunner;
  /** 子智能体监督者（M12）：注入后 task 工具可派发子 Agent。 */
  supervisor?: SubAgentSupervisor;
  /** 无人值守评估选项（M13 I1）：注入后 evaluate 时 ask 一律静态化为 deny。 */
  evaluateOptions?: EvaluateOptions;
  /** M16 记忆管理器：会话启动时提示待确认候选 + 每轮语义检索刷新（注入 L4）。 */
  memoryManager?: MemoryManager;
  /** M16 工具侧记忆访问（memory_write/search/forget 工具）。 */
  memoryAccess?: MemoryAccess;
  /** M17 工具侧视觉访问（screenshot 工具）。 */
  visionAccess?: VisionAccess;
  /** M18 钩子执行器（已加载的 hooks）。未注入则不触发任何 hook。 */
  hooks?: HookRunner;
  /** M18 已加载的钩子清单（供 HookRunner.run 过滤事件）。 */
  resolvedHooks?: ResolvedHook[];
}

export class AgentEngine {
  private readonly approval: ApprovalGateway;
  private readonly workspace: Workspace;
  private readonly aborts = new Map<string, AbortController>();
  private readonly active = new Map<string, Session>();
  private readonly freshness = new Map<string, FreshnessTracker>();
  /** 子会话 id → 父会话 id（审批冒泡路由用）。 */
  private readonly subParent = new Map<string, string>();
  /** 会话 id → 实时事件出口（子会话由 Supervisor 注入，用于即时桥接审批/进度）。 */
  private readonly sinks = new Map<string, (e: AgentEvent) => void>();
  /** 主机级事件出口（宿主注册）。 */
  private hostSink?: (e: AgentEvent) => void;
  /** 会话级 hook 提示缓冲（M18 §18.4）：inherited=上一轮产生的提示，fresh=本轮新产生。 */
  private readonly hookNotes = new Map<string, { inherited: string[]; fresh: string[] }>();

  constructor(private readonly deps: EngineDeps) {
    this.approval = deps.approval ?? new InteractiveApprovalGateway();
    this.workspace = deps.workspace;
  }

  /** 由 factory 在构造后回注监督者（解耦引擎 ↔ 监督者的循环依赖，M12）。 */
  attachSupervisor(supervisor: SubAgentSupervisor): void {
    (this.deps as { supervisor?: SubAgentSupervisor }).supervisor = supervisor;
  }

  /** 引擎持有的 workspace（供宿主层 /undo 等直接复用）。 */
  get workspaceRoot(): Workspace {
    return this.workspace;
  }

  /** 暴露监督者（宿主查询子会话 / 模板）。 */
  get subAgentSupervisor(): SubAgentSupervisor | undefined {
    return this.deps.supervisor;
  }

  /** 注册子会话归属（M12 §12.7 审批冒泡路由 + §12.12 abort 级联）。 */
  registerSubSession(subSessionId: string, parentSessionId: string): void {
    this.subParent.set(subSessionId, parentSessionId);
    this.aborts.set(subSessionId, new AbortController());
  }

  /** 注销子会话。 */
  unregisterSubSession(subSessionId: string): void {
    this.subParent.delete(subSessionId);
    this.aborts.delete(subSessionId);
    this.sinks.delete(subSessionId);
  }

  /** 为会话注入实时事件出口（Supervisor 用；审批等阻塞前的事件需即时桥接）。 */
  setEventSink(sessionId: string, sink: (e: AgentEvent) => void): void {
    this.sinks.set(sessionId, sink);
  }

  clearEventSink(sessionId: string): void {
    this.sinks.delete(sessionId);
  }

  /**
   * 主机级事件出口（宿主注册）：所有会话（含子会话桥接事件）的实时事件都会经过它。
   * 子智能体审批冒泡必须走此通道——父 run() 生成器在等待工具执行期间无法 yield。
   */
  setHostEventSink(sink: ((e: AgentEvent) => void) | undefined): void {
    this.hostSink = sink;
  }

  /** 从任意会话向外发出实时事件（审批冒泡等），同时尝试所属父会话的 sink。 */
  emitLive(event: AgentEvent, originSessionId?: string): void {
    this.hostSink?.(event);
    if (originSessionId) {
      const parent = this.subParent.get(originSessionId);
      if (parent) this.sinks.get(parent)?.(event);
    }
  }

  /**
   * 触发某生命周期事件的全部钩子（M18 §18.4）。
   * 仅当注入了 HookRunner 且有对应事件清单时才执行；stdout 的 {"note"} 自动累积进
   * 会话的 fresh 提示缓冲（由 run() 在每轮上下文组装时注入 L4）。
   * @param blocking 前置类事件（tool:pre/approval:pre）置 true：任一 block 即短路。
   */
  private async runHooks(
    event: HookEvent,
    rest: Record<string, unknown>,
    blocking: boolean,
    sid: string,
  ): Promise<HookOutcome[]> {
    if (!this.deps.hooks || !this.deps.resolvedHooks || this.deps.resolvedHooks.length === 0) {
      return [];
    }
    const payload: HookPayload = { event, ...rest };
    const outcomes = await this.deps.hooks.run(event, this.deps.resolvedHooks, payload, {
      sessionId: sid,
      blocking,
    });
    const st = this.hookNotes.get(sid);
    if (st) {
      for (const o of outcomes) if (o.note) st.fresh.push(o.note);
    }
    return outcomes;
  }

  resolveApproval(sessionId: string, callId: string, decision: 'allow' | 'deny'): void {
    this.approval.resolve(callId, decision);
  }

  abort(sessionId: string, reason = 'user_interrupt'): void {
    this.aborts.get(sessionId)?.abort(reason);
    // 级联取消子树（§12.12）。
    for (const [sub, parent] of this.subParent) {
      if (parent === sessionId) this.abort(sub, 'parent_interrupted');
    }
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.active.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.id,
      state: s.running ? 'executing' : 'idle',
      currentStep: s.messages.filter((m) => m.role === 'assistant').length,
      lastToolCalls: [],
      pendingApprovals: [],
      usage: s.usage,
      startedAt: now(),
    };
  }

  private freshnessFor(sessionId: string): FreshnessTracker {
    let t = this.freshness.get(sessionId);
    if (!t) {
      t = new FreshnessTracker();
      this.freshness.set(sessionId, t);
    }
    return t;
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    const override: Partial<SessionConfig> = { ...(input.overrides ?? {}) };
    if (this.deps.policyMode && !override.policy) {
      override.policy = { mode: this.deps.policyMode, rules: [] };
    }
    const session =
      (input.session as Session | undefined) ??
      this.deps.sessions.loadOrCreate(input.sessionId, override);
    if (session.running) {
      yield {
        type: 'error',
        error: {
          code: ErrorCodes.ERR_SESSION_BUSY,
          message: 'session is busy',
          recoverable: false,
        },
        recoverable: false,
        ts: now(),
      };
      return;
    }
    session.running = true;
    if (!session.parentSessionId) this.deps.sessions.updateRunning(session.id, true);
    this.active.set(session.id, session);
    const ac = new AbortController();
    this.aborts.set(session.id, ac);
    const onAbort = (): void => ac.abort((input.signal as { reason?: string } | null)?.reason);
    input.signal?.addEventListener('abort', onAbort);
    const sid = session.id;
    const tracker = this.freshnessFor(sid);
    this.hookNotes.set(sid, { inherited: [], fresh: [] });

    try {
      const turnId = genId('turn');
      yield { type: 'turn.started', turnId, input: input.text, ts: now() };
      this.log(session, { type: 'turn.started', turnId, input: input.text, ts: now() });
      session.messages.push({ role: 'user', content: [{ type: 'text', text: input.text }] });

      // ---- M18 生命周期钩子：session:start（一次）----
      await this.runHooks('session:start', { input: input.text, model: session.config.models.executor }, false, sid);
      // ---- M16 会话启动：提示待确认记忆候选（如有）----
      this.deps.memoryManager?.onSessionStart();
      // ---- M18 turn:start（一次）----
      await this.runHooks('turn:start', { turnIndex: 0, model: session.config.models.executor }, false, sid);

      const limits = session.limits;
      for (let step = 0; step < limits.maxSteps; step++) {
        if (ac.signal.aborted) {
          yield { type: 'task.completed', reason: 'user_interrupt', ts: now() };
          break;
        }

        // ── Auto-Compact（§5.4）：预算命中且距上次压缩 ≥ minIntervalTurns ──
        await this.maybeCompact(session, tracker, sid, (e) => this.pending.push(e));

        // ── M16 每轮：节流刷新语义检索（注入 L4 由 ContextManager 完成）──
        await this.deps.memoryManager?.onTurn(step, input.text);

        const hn = this.hookNotes.get(sid);
        const view = this.deps.context.build(session, {
          dirtyFiles: tracker.checkDirty().map((abs) =>
            FreshnessTracker.relativize(abs, this.workspace.root),
          ),
          ...(hn ? { hookNotes: [...hn.inherited, ...hn.fresh] } : {}),
        });
        const provider = this.deps.providers.resolve(session.config.models.executor);
        const stream = provider.chat({
          messages: view.messages,
          tools: this.toolSchemasFor(session),
          signal: ac.signal,
          maxOutputTokens: limits.maxOutputTokens,
          sessionId: session.id,
        });

        let reply: AssistantMessage | undefined;
        for await (const ev of stream) {
          if (ev.type === 'text.delta') yield { type: 'message.delta', text: ev.text, ts: now() };
          if (ev.type === 'usage' && ev.usage) session.usage = mergeUsage(session.usage, ev.usage);
        }
        reply = stream.result();
        if (ac.signal.aborted) {
          yield { type: 'task.completed', reason: 'user_interrupt', ts: now() };
          break;
        }

        // riskLevel 由注册表中的工具定义确定（模型/脚本返回的占位值不可信）
        if (reply.toolCalls) {
          for (const c of reply.toolCalls) {
            const t = this.deps.tools.get(c.name);
            if (t) c.riskLevel = t.riskLevel;
          }
        }

        yield { type: 'message.completed', message: reply, ts: now() };
        this.log(session, { type: 'message.completed', message: reply, ts: now() });
        session.messages.push(reply);

        if (!reply.toolCalls || reply.toolCalls.length === 0) {
          yield { type: 'task.completed', reason: 'model_finished', ts: now() };
          this.log(session, { type: 'task.completed', reason: 'model_finished', ts: now() });
          break;
        }

        // 读并行 / 写串行 调度
        const groups = this.deps.tools.groupBySafety(reply.toolCalls);
        for (const group of groups) {
          const outcomes = await Promise.all(
            group.map((call) => this.executeOne(session, call, ac.signal)),
          );
          for (const evs of outcomes) for (const e of evs) yield e;
        }

        // shell 之后工作区可能被外部修改：增量扫描（§5.6）。
        session.meta.turnsSinceLastCompact = (session.meta.turnsSinceLastCompact ?? 0) + 1;
        // 新 turn 重置子智能体派发计数（§12.5 maxPerTurn 按轮计）。
        session.subSpawnCount = 0;
        this.deps.supervisor?.resetTurnSlots(session.id);
        // 持久化会话级元数据（todo 列表等），resume 时恢复。
        if (!session.parentSessionId) this.deps.sessions.saveMeta(session.id, session.meta);

        // ── M18 turn:end 钩子 + 提示滚动（本轮 fresh → 下轮 inherited）──
        await this.runHooks('turn:end', { turnIndex: step, steps: step + 1, usage: session.usage }, false, sid);
        const hnEnd = this.hookNotes.get(sid);
        if (hnEnd) {
          hnEnd.inherited = hnEnd.fresh;
          hnEnd.fresh = [];
        }

        yield { type: 'turn.completed', usage: session.usage, steps: step + 1, ts: now() };
        this.log(session, {
          type: 'turn.completed',
          usage: session.usage,
          steps: step + 1,
          ts: now(),
        });
      }
    } catch (err) {
      const e = toMoziError(err);
      const ae: AgentError = {
        code: e.code,
        message: e.message,
        recoverable: e.recoverable,
        detail: e.detail,
      };
      yield { type: 'error', error: ae, recoverable: e.recoverable, ts: now() };
    } finally {
      session.running = false;
      if (!session.parentSessionId) this.deps.sessions.updateRunning(sid, false);
      this.active.delete(sid);
      this.aborts.delete(sid);
      input.signal?.removeEventListener('abort', onAbort);
      // ── M18 session:end 钩子（无论正常完成/中断/异常）──
      await this.runHooks('session:end', { turnIndex: 0 }, false, sid);
      this.hookNotes.delete(sid);
    }
    // 冲刷压缩等内部挂起事件（顺序保证在 task.completed 之后）。
    if (this.pending.length) {
      const flushed: AgentEvent[] = [];
      while (this.pending.length) flushed.push(this.pending.shift()!);
      for (const e of flushed) yield e;
    }
  }

  /** 事件挂起队列：压缩等异步动作产生的事件需要在引擎循环中安全地 yield。 */
  private readonly pending: AgentEvent[] = [];

  /** 会话事件落盘：子会话写入 subs/<id>/，父会话写入自身。 */
  private log(session: Session, ev: AgentEvent): void {
    this.deps.sessions.appendEvent(session.id, ev);
  }

  /** 子会话可用的工具 schema（能力裁剪，§12.12）。 */
  private toolSchemasFor(session: Session): Array<{
    name: string;
    description: string;
    parameters: unknown;
  }> {
    const all = this.deps.tools.schemas();
    const enabled = session.config.enabledTools;
    if (!enabled || enabled.includes('*')) return all;
    const allow = new Set(enabled);
    return all.filter((s) => allow.has(s.name) || (s.name === 'task' && allow.has('task')));
  }

  /** Auto-Compact 触发与执行（§5.4）。失败跳过，不阻塞任务。 */
  private async maybeCompact(
    session: Session,
    tracker: FreshnessTracker,
    sid: string,
    emit: (e: AgentEvent) => void,
  ): Promise<void> {
    const budget = this.deps.context.budgetFor(session);
    const threshold = session.config.context.autoCompactThreshold ?? 0.8;
    const view: BuildView = this.deps.context.build(session, {});
    const check = shouldCompact(view.messages, {
      budgetTokens: budget,
      threshold,
      minIntervalTurns: 3,
      turnsSinceLastCompact: session.meta.turnsSinceLastCompact ?? 0,
    });
    if (!check.should) return;
    // ── M18 compact:pre 钩子 ──
    await this.runHooks('compact:pre', { turnsSinceLastCompact: session.meta.turnsSinceLastCompact ?? 0 }, false, sid);
    const provider = this.deps.providers.resolve(session.config.models.executor);
    const result = await compactMessages(session.messages, provider, session.id);
    if (!result) {
      // 失败跳过（仍触发 compact:post 通知）
      await this.runHooks('compact:post', { skipped: true }, false, sid);
      return;
    }
    session.messages.splice(0, session.messages.length, ...result.messages);
    session.meta.turnsSinceLastCompact = 0;
    session.meta.compactCount = (session.meta.compactCount ?? 0) + 1;
    const ev: AgentEvent = {
      type: 'context.compacted',
      removedTurns: result.removedTurns,
      savedTokens: result.savedTokens,
      summary: result.summary,
      ts: now(),
    };
    this.log(session, ev);
    emit(ev);
    // ── M18 compact:post 钩子 ──
    await this.runHooks('compact:post', { removedTurns: result.removedTurns, savedTokens: result.savedTokens }, false, sid);
  }

  /** 等待审批：超时自动 deny（M6 §6.1.3 / M12 §12.7，默认 10 分钟）。 */
  private async awaitApproval(
    session: Session,
    call: ToolCall,
    reason: Parameters<ApprovalGateway['request']>[1],
  ): Promise<'allow' | 'deny'> {
    const timeoutMs = session.limits.toolTimeoutMs > 0 ? Math.max(session.limits.toolTimeoutMs, 600_000) : 600_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.approval.request(call, reason),
        new Promise<'deny'>((resolve) => {
          timer = setTimeout(() => resolve('deny'), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeOne(
    session: Session,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<AgentEvent[]> {
    const evs: AgentEvent[] = [];
    const sid = session.id;
    const sink = this.sinks.get(sid);
    const push = (e: AgentEvent): void => {
      evs.push(e);
      this.log(session, e);
      // 实时出口：让 Supervisor 在阻塞（如等待审批）之前就能桥接事件。
      if (sink) sink(e);
      // 宿主级实时出口：无人值守宿主（桌面 AgentService）在后台消费生成器，
      // 审批事件必须**立即**上抛，否则宿主无法在 executeOne 阻塞前 resolve，
      // 形成「宿主等事件 / 引擎等审批」死锁。仅审批类事件走此通道，避免
      // 其余事件被宿主与生成器双份消费。
      if (e.type === 'tool.approval.required' || e.type === 'tool.approval.resolved') {
        this.hostSink?.(e);
      }
    };

    push({ type: 'tool.requested', call, ts: now() });

    const decision = this.deps.policy.evaluate(call, session.config.policy, this.deps.evaluateOptions ?? {});
    let allowed = false;
    if (decision.type === 'allow') {
      allowed = true;
    } else if (decision.type === 'deny') {
      allowed = false;
    } else {
      // ── M18 approval:pre 钩子（可阻止审批，等价于 deny）──
      const approvalPre = await this.runHooks(
        'approval:pre',
        { tool: call.name, reason: decision.reason },
        true,
        sid,
      );
      if (approvalPre.some((o) => o.action === 'block')) {
        const blocked = approvalPre.find((o) => o.action === 'block');
        const result: ToolResult = {
          callId: call.id,
          content: `Blocked by hook (approval:pre): ${blocked?.stdout || 'approval denied'}`,
          isError: true,
          meta: { errorKind: 'hook-blocked' },
        };
        push({ type: 'tool.completed', callId: call.id, result, ts: now() });
        session.messages.push({
          role: 'tool',
          callId: call.id,
          content: result.content,
          isError: true,
        });
        return evs;
      }
      push({ type: 'tool.approval.required', call, reason: decision.reason, ts: now() });
      const answer = await this.awaitApproval(session, call, decision.reason);
      push({
        type: 'tool.approval.resolved',
        callId: call.id,
        decision: answer,
        by: 'user',
        ts: now(),
      });
      // ── M18 approval:post 钩子 ──
      await this.runHooks('approval:post', { tool: call.name, decision: answer }, false, sid);
      allowed = answer === 'allow';
    }

    if (!allowed) {
      const result: ToolResult = {
        callId: call.id,
        content: `Denied by policy (rule ${'ruleId' in decision ? decision.ruleId : 'approval'}).`,
        isError: true,
        meta: { errorKind: 'denied' },
      };
      push({ type: 'tool.completed', callId: call.id, result, ts: now() });
      session.messages.push({
        role: 'tool',
        callId: call.id,
        content: result.content,
        isError: true,
      });
      return evs;
    }

    push({ type: 'tool.started', callId: call.id, ts: now() });
    const tool = this.deps.tools.get(call.name);
    if (!tool) {
      const result: ToolResult = {
        callId: call.id,
        content: `tool not found: ${call.name}`,
        isError: true,
        meta: { errorKind: ErrorCodes.ERR_TOOL_NOT_FOUND },
      };
      push({ type: 'tool.completed', callId: call.id, result, ts: now() });
      session.messages.push({
        role: 'tool',
        callId: call.id,
        content: result.content,
        isError: true,
      });
      return evs;
    }

    // ── M18 tool:pre 钩子（可阻止工具执行，等价于 deny）──
    const toolPre = await this.runHooks(
      'tool:pre',
      { tool: call.name, arguments: call.arguments ?? {}, riskLevel: call.riskLevel },
      true,
      sid,
    );
    if (toolPre.some((o) => o.action === 'block')) {
      const blocked = toolPre.find((o) => o.action === 'block');
      const result: ToolResult = {
        callId: call.id,
        content: `Blocked by hook (tool:pre): ${blocked?.stdout || 'tool execution denied'}`,
        isError: true,
        meta: { errorKind: 'hook-blocked' },
      };
      push({ type: 'tool.completed', callId: call.id, result, ts: now() });
      session.messages.push({
        role: 'tool',
        callId: call.id,
        content: result.content,
        isError: true,
      });
      return evs;
    }

    const startedAt = Date.now();
    const tracker = this.freshnessFor(sid);
    let result: ToolResult;
    try {
      result = await withTimeout(
        tool.execute(call.arguments as Record<string, unknown>, {
          workspace: this.workspace,
          signal,
          sessionId: session.id,
          sandbox: this.deps.sandbox,
          session,
          supervisor: this.deps.supervisor,
          ...(this.deps.memoryAccess ? { memory: this.deps.memoryAccess } : {}),
          ...(this.deps.visionAccess ? { vision: this.deps.visionAccess } : {}),
          emit: (e) => evs.push(e),
        }),
        session.limits.toolTimeoutMs,
        signal,
      );
      result.callId = call.id;
      if (result.meta) result.meta.durationMs = Date.now() - startedAt;
      this.recordFreshness(session, call, tracker);
      // todo_list 等会话级状态变更立即落盘。
      if (call.name === 'todo_list' && !session.parentSessionId) {
        this.deps.sessions.saveMeta(session.id, session.meta);
      }
      push({ type: 'tool.completed', callId: call.id, result, ts: now() });
      session.messages.push({
        role: 'tool',
        callId: call.id,
        content: result.content,
        isError: result.isError,
      });
    } catch (err) {
      const e = toMoziError(err);
      result = {
        callId: call.id,
        content: `Error: ${e.message}`,
        isError: true,
        meta: { errorKind: e.code },
      };
      push({ type: 'tool.completed', callId: call.id, result, ts: now() });
      session.messages.push({
        role: 'tool',
        callId: call.id,
        content: result.content,
        isError: true,
      });
    }
    // ── M18 tool:post 钩子（无论成功/失败均触发）──
    await this.runHooks('tool:post', { tool: call.name, callId: call.id, isError: result.isError }, false, sid);
    return evs;
  }

  /** 工具执行后更新新鲜度基准（§5.6）：读过的文件记基准，shell 后全量重扫。 */
  private recordFreshness(session: Session, call: ToolCall, tracker: FreshnessTracker): void {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    if (READ_FILE_TOOLS.has(call.name) && typeof args['path'] === 'string') {
      tracker.markRead(this.workspace.resolve(args['path'] as string));
      return;
    }
    if (call.name === 'shell') {
      // shell 可能改文件：对已见文件做一次比对（增量成本可控）。
      tracker.checkDirty();
    }
  }
}
