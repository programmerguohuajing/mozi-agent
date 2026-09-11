/**
 * 子智能体监督者（M12 §12.2/§12.5–§12.9）。
 * 子 Agent = 同一个 AgentEngine.run() 的另一次调用（不引入第二套引擎）。
 * 职责：模板解析 → 子会话合成 → 权限单调收紧 → 并发槽 → 嵌套运行 → 进度桥接 / 审批冒泡 → 摘要回传。
 */
import type { AgentEvent, PolicyMode, ToolResult } from '@mozi/shared';
import type { SubAgentDispatcher, ToolContext } from '@mozi/tools';
import { estimateTokens } from '../context/compactor.js';
import type { HookRunner } from '../hooks/runner.js';
import type { ResolvedHook } from '../hooks/types.js';
import type { Session, SessionStore } from '../session/session-store.js';
import { TemplateRegistry } from './templates.js';

export interface SubAgentConfig {
  /** 全局同时运行子 Agent 上限（默认 3；超出排队）。 */
  maxConcurrent: number;
  /** 嵌套深度上限（默认 2）。 */
  maxDepth: number;
  /** 单个 turn 内 spawn 总数上限（默认 8）。 */
  maxPerTurn: number;
  /** 默认超时（默认 300_000）。 */
  defaultTimeoutMs: number;
}

export const DEFAULT_SUBAGENT_CONFIG: SubAgentConfig = {
  maxConcurrent: 3,
  maxDepth: 2,
  maxPerTurn: 8,
  defaultTimeoutMs: 300_000,
};

/** 策略严格序：readonly < auto < full-auto（min = 取更严）。 */
const POLICY_RANK: Record<PolicyMode, number> = { readonly: 0, auto: 1, 'full-auto': 2 };

export function tighten(parent: PolicyMode, template: PolicyMode): PolicyMode {
  const rank = Math.min(POLICY_RANK[parent] ?? 1, POLICY_RANK[template] ?? 1);
  return (Object.keys(POLICY_RANK) as PolicyMode[]).find((k) => POLICY_RANK[k] === rank) ?? 'auto';
}

export function intersectTools(
  parentEnabled: string[] | undefined,
  templateAllowed: string[] | '*',
): string[] | '*' {
  if (!parentEnabled || parentEnabled.includes('*')) {
    return templateAllowed === '*' ? '*' : templateAllowed;
  }
  if (templateAllowed === '*') return parentEnabled;
  const allow = new Set(templateAllowed);
  return parentEnabled.filter((t) => allow.has(t));
}

/** 极简 FIFO 信号量。 */
class Semaphore {
  private available: number;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  constructor(size: number) {
    this.available = size;
  }
  /** 返回排队位置：0 表示立即获得槽位，>0 表示前面有 N 个等待者。 */
  async acquire(signal?: AbortSignal): Promise<number> {
    if (this.available > 0) {
      this.available--;
      this.inFlight++;
      return 0;
    }
    const position = this.queue.length + 1;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('aborted while queued'));
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.inFlight++;
        resolve();
      };
      this.queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return position;
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else {
      this.available++;
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }
  /** 当前排队数量。 */
  get queued(): number {
    return this.queue.length;
  }
  /** 当前在跑数量。 */
  get active(): number {
    return this.inFlight;
  }
}

/** Supervisor 依赖的引擎契约（避免与 AgentEngine 循环依赖）。 */
export interface EngineRunner {
  run(input: {
    sessionId: string;
    text: string;
    signal?: AbortSignal;
    session?: Session;
  }): AsyncGenerator<AgentEvent>;
  /** 可选：注册实时事件出口（审批等阻塞前即时桥接）。 */
  setEventSink?(sessionId: string, sink: (e: AgentEvent) => void): void;
  clearEventSink?(sessionId: string): void;
  /** 可选：向宿主事件流广播实时事件（审批冒泡）。 */
  emitLive?(event: AgentEvent, originSessionId?: string): void;
}

export interface SupervisorDeps {
  engine: EngineRunner;
  sessions: SessionStore;
  templates: TemplateRegistry;
  config?: Partial<SubAgentConfig>;
  /** M18：task:run:pre/post 钩子执行器与已加载清单。 */
  hooks?: HookRunner;
  resolvedHooks?: ResolvedHook[];
}

const SUMMARY_CAP_TOKENS = 4000;

/** 截断摘要：>4k token 时保留「结论 + 相关文件」段，优先丢弃「建议」段（§12.9）。 */
export function truncateSummary(text: string, capTokens = SUMMARY_CAP_TOKENS): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= capTokens) return { text, truncated: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let inSuggest = false;
  for (const line of lines) {
    if (/^#{1,3}\s*建议/.test(line)) inSuggest = true;
    if (inSuggest) continue;
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), truncated: true };
}

export class SubAgentSupervisor implements SubAgentDispatcher {
  private readonly semaphore: Semaphore;
  private readonly cfg: SubAgentConfig;
  private subSeq = 0;
  /** 父会话 id → 本轮已预留的派发数（同步占位，防并行竞态）。 */
  private readonly turnSlots = new Map<string, number>();

  constructor(private readonly deps: SupervisorDeps) {
    this.cfg = { ...DEFAULT_SUBAGENT_CONFIG, ...(deps.config ?? {}) };
    this.semaphore = new Semaphore(this.cfg.maxConcurrent);
  }

  /** 同步预留本轮派发槽位；超限返回 null。 */
  private reserveTurnSlot(parentId: string): number | null {
    const used = this.turnSlots.get(parentId) ?? 0;
    if (used >= this.cfg.maxPerTurn) return null;
    this.turnSlots.set(parentId, used + 1);
    return used + 1;
  }

  private releaseTurnSlot(parentId: string): void {
    const used = this.turnSlots.get(parentId) ?? 0;
    this.turnSlots.set(parentId, Math.max(0, used - 1));
  }

  get maxDepth(): number {
    return this.cfg.maxDepth;
  }

  templates(): Array<{ type: string; description: string }> {
    return this.deps.templates.list().map((t) => ({ type: t.type, description: t.description }));
  }

  /** task 工具入口（§12.4）。所有校验失败都返回 isError ToolResult，不抛异常。 */
  async dispatch(
    spec: { agent: string; prompt: string; contextFiles?: string[]; timeoutMs?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parent = ctx.session as unknown as Session | undefined;
    // 桥接事件统一走「宿主实时通道」（§12.8）：父 run() 生成器在等待工具执行期间无法 yield，
    // 审批冒泡/进度必须经此通道即时送达 UI。ctx.emit 为空时退化为仅宿主通道。
    const emit = (e: AgentEvent): void => {
      this.deps.engine.emitLive?.(e, ctx.sessionId);
    };
    if (!parent) {
      return { callId: '', content: 'task unavailable: no parent session', isError: true };
    }
    const parentPolicy: PolicyMode = parent.config.policy.mode;

    // ── 校验链（同步预留计数：task 为并行组，必须同步占位防竞态） ──
    const depth = parent.depth ?? 0;
    if (depth + 1 > this.cfg.maxDepth) {
      return err(
        `已达最大子智能体深度 ${this.cfg.maxDepth}（防递归失控），请在当前上下文直接执行`,
      );
    }
    const reserved = this.reserveTurnSlot(parent.id);
    if (reserved === null) {
      return err(`本轮子智能体派发数已达上限（${this.cfg.maxPerTurn}）`);
    }
    const template = this.deps.templates.resolve(spec.agent);
    if (!template) {
      this.releaseTurnSlot(parent.id);
      const available = this.templates().map((t) => t.type).join(', ');
      return err(`未知子智能体模板 '${spec.agent}'。可用模板：${available}`);
    }

    // ── M18 task:run:pre 钩子（可阻止子智能体派发）──
    if (this.deps.hooks && this.deps.resolvedHooks && this.deps.resolvedHooks.length) {
      const pre = await this.deps.hooks.run(
        'task:run:pre',
        this.deps.resolvedHooks,
        { event: 'task:run:pre', agent: spec.agent, prompt: spec.prompt, sessionId: parent.id },
        { sessionId: parent.id, blocking: true },
      );
      if (pre.some((o) => o.action === 'block')) {
        this.releaseTurnSlot(parent.id);
        const blocked = pre.find((o) => o.action === 'block');
        return err(`子智能体派发被 hook 阻止：${blocked?.stdout || 'task:run:pre'}`);
      }
    }

    const subId = `sub-${++this.subSeq}`;
    const subSessionId = `${parent.id}/subs/${subId}`;
    const slot = await this.semaphore.acquire(ctx.signal).catch(async (e) => {
      this.releaseTurnSlot(parent.id);
      throw e;
    });
    if (slot > 0) {
      emit({
        type: 'subagent.queued',
        subSessionId,
        queuePosition: slot,
        ts: new Date().toISOString(),
      });
    }

    // ── 子会话合成（权限单调收紧 §12.6）──
    const childPolicy = tighten(parentPolicy, template.policy);
    const childTools = intersectTools(parent.config.enabledTools, template.allowedTools);
    const sub = this.deps.sessions.createSub(parent, {
      subId,
      template: template.type,
      config: {
        policy: { mode: childPolicy, rules: parent.config.policy.rules },
        enabledTools: childTools === '*' ? ['*'] : childTools,
        context: { ...parent.config.context, maxTokens: template.contextBudgetTokens },
        limits: { ...(parent.config.limits ?? {}), maxSteps: template.maxSteps },
      },
    });
    parent.subSpawnCount = (parent.subSpawnCount ?? 0) + 1;

    const startedAt = Date.now();
    emit({
      type: 'subagent.started',
      subSessionId,
      parentSessionId: parent.id,
      agentType: template.type,
      prompt: spec.prompt,
      ts: new Date().toISOString(),
    });

    const cascade = new AbortController();
    const onParentAbort = (): void => cascade.abort('parent_interrupted');
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });

    const timeoutMs = Math.min(
      spec.timeoutMs ?? template.timeoutMs ?? this.cfg.defaultTimeoutMs,
      600_000,
    );
    const timer = setTimeout(() => cascade.abort('timeout'), timeoutMs);

    let lastAssistant = '';
    let steps = 0;
    const callNames = new Map<string, string>();
    let maxSteps = template.maxSteps;
    // 注册实时出口：审批等阻塞事件在等待前即桥接到宿主事件流（§12.7）。
    this.deps.engine.setEventSink?.(subSessionId, (e) =>
      this.bridge(emit, subSessionId, template.type, e, callNames, maxSteps, (n) => (steps = n)),
    );
    try {
      const prompt = await this.buildPrompt(template.systemPrompt, spec, ctx);
      const gen = this.deps.engine.run({
        sessionId: subSessionId,
        text: prompt,
        signal: cascade.signal,
        session: sub,
      });
      for await (const ev of gen) {
        if (ev.type === 'tool.requested') callNames.set(ev.call.id, ev.call.name);
        // 低频桥接 + 审批冒泡（§12.7/§12.8）。审批事件已由 sink 即时发出，
        // 此处去重：仅桥接非审批类事件。
        if (ev.type !== 'tool.approval.required') {
          this.bridge(
            emit,
            subSessionId,
            template.type,
            ev,
            callNames,
            maxSteps,
            (n) => (steps = n),
          );
        }
        if (ev.type === 'message.completed' && ev.message.role === 'assistant') {
          if (ev.message.content) lastAssistant = ev.message.content;
        }
        if (cascade.signal.aborted) break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: 'subagent.failed',
        subSessionId,
        error: { code: 'ERR_SUBAGENT', message, recoverable: true },
        ts: new Date().toISOString(),
      });
      this.cleanup(parent, subSessionId, cascade, onParentAbort, timer, ctx);
      const durationMs = Date.now() - startedAt;
      // ── M18 task:run:post 钩子（派发失败路径）──
      if (this.deps.hooks && this.deps.resolvedHooks && this.deps.resolvedHooks.length) {
        await this.deps.hooks.run(
          'task:run:post',
          this.deps.resolvedHooks,
          {
            event: 'task:run:post',
            agent: spec.agent,
            subSessionId,
            steps,
            durationMs,
            isError: true,
            sessionId: parent.id,
          },
          { sessionId: parent.id, blocking: false },
        );
      }
      return { callId: '', content: `sub-agent failed: ${message}`, isError: true };
    }
    void maxSteps;

    this.cleanup(parent, subSessionId, cascade, onParentAbort, timer, ctx);
    const durationMs = Date.now() - startedAt;

    // ── M18 task:run:post 钩子（派发完成，成功路径）──
    if (this.deps.hooks && this.deps.resolvedHooks && this.deps.resolvedHooks.length) {
      await this.deps.hooks.run(
        'task:run:post',
        this.deps.resolvedHooks,
        {
          event: 'task:run:post',
          agent: spec.agent,
          subSessionId,
          steps,
          durationMs,
          isError: false,
          sessionId: parent.id,
        },
        { sessionId: parent.id, blocking: false },
      );
    }

    const summary = lastAssistant.trim() || '(sub-agent produced no final summary)';
    const truncated = truncateSummary(summary);
    emit({
      type: 'subagent.completed',
      subSessionId,
      summary: truncated.text,
      usage: sub.usage,
      steps,
      durationMs,
      ts: new Date().toISOString(),
    });

    const usageLine = `[usage: steps=${steps}, tokens=${sub.usage.totalTokens}, duration=${Math.round(
      durationMs / 1000,
    )}s]`;
    const body = truncateSummary(lastAssistant.trim());
    const content = [
      `<subagent type="${template.type}" prompt="${spec.prompt}">`,
      body.text,
      '</subagent>',
      usageLine,
    ].join('\n');
    return {
      callId: '',
      content,
      display: { kind: 'markdown', text: content },
      isError: false,
      meta: { subSessionId, truncated: truncated.truncated },
    };
  }

  /** 首条消息组装（§12.9）：模板提示 + 工作区 + contextFiles（各截断 2k） + 收尾指令。 */
  private async buildPrompt(
    systemPrompt: string,
    spec: { prompt: string; contextFiles?: string[] },
    ctx: ToolContext,
  ): Promise<string> {
    const parts = [spec.prompt];
    if (spec.contextFiles?.length) {
      const injected: string[] = [];
      for (const f of spec.contextFiles) {
        try {
          const abs = ctx.workspace.resolve(f);
          const content = ctx.workspace.readFile(abs) ?? '';
          injected.push(`<file path="${f}">\n${content.slice(0, 2000)}\n</file>`);
        } catch {
          /* skip unreadable */
        }
      }
      if (injected.length) parts.push('\n# 预注入文件\n' + injected.join('\n'));
    }
    parts.push(
      '\n（工作区：' +
        ctx.workspace.root +
        '。任务即将结束时请输出最终结构化摘要：## 结论 / ## 相关文件（file:line）/ ## 建议。' +
        '该摘要是你唯一能传回主任务的产物，遗漏即丢失。）',
    );
    return `${systemPrompt}\n\n---\n${parts.join('\n')}`;
  }

  /** 事件桥接：progress（每 step 一条）+ 审批冒泡。 */
  private bridge(
    emit: (e: AgentEvent) => void,
    subSessionId: string,
    agentType: string,
    ev: AgentEvent,
    callNames: Map<string, string>,
    maxSteps: number,
    setSteps: (n: number) => void,
  ): void {
    const ts = new Date().toISOString();
    if (ev.type === 'tool.approval.required') {
      emit({
        type: 'subagent.approval.required',
        subSessionId,
        callId: ev.call.id,
        agentType,
        call: ev.call,
        reason: ev.reason,
        ts,
      });
      return;
    }
    if (ev.type === 'tool.started') {
      emit({
        type: 'subagent.progress',
        subSessionId,
        step: 0,
        maxSteps,
        currentTool: callNames.get(ev.callId),
        tokensUsed: 0,
        ts,
      });
      return;
    }
    if (ev.type === 'turn.completed') {
      setSteps(ev.steps);
      emit({
        type: 'subagent.progress',
        subSessionId,
        step: ev.steps,
        maxSteps,
        tokensUsed: ev.usage.totalTokens,
        ts,
      });
    }
  }

  private cleanup(
    parent: Session,
    subSessionId: string,
    cascade: AbortController,
    onParentAbort: () => void,
    timer: NodeJS.Timeout,
    ctx: ToolContext,
  ): void {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onParentAbort);
    if (!cascade.signal.aborted) cascade.abort('done');
    this.deps.engine.clearEventSink?.(subSessionId);
    this.semaphore.release();
    this.releaseTurnSlot(parent.id);
    void subSessionId;
  }

  /** 重置某父会话的「本轮派发计数」（引擎在每个 turn 边界调用）。 */
  resetTurnSlots(parentSessionId: string): void {
    this.turnSlots.delete(parentSessionId);
  }
}

function err(content: string): ToolResult {
  return { callId: '', content, isError: true, meta: { errorKind: 'subagent-rejected' } };
}
