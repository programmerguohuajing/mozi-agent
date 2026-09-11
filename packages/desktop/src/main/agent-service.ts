/**
 * AgentService：Electron 主进程的会话池与事件扇出（M10 §10.2 / §10.4）。
 *
 * 职责：
 *   - 每会话独立 AgentEngine 实例（`sessionPool`），天然支持多会话并行；
 *   - 事件扇出：引擎事件按 sessionId 分桶，经 `engine:event` 推送到窗口；
 *   - 子智能体桥接事件（progress / approval）经宿主实时通道即时送达（M12 §12.8）；
 *   - 窗口关闭 ≠ 会话销毁：引擎继续跑完当前 turn（后台完成，状态徽标 running）；
 *   - 退出时全部会话 flush + abort（graceful，10s 上限）。
 *
 * 本类不依赖 electron —— 通过注入的 `emit` 回调（由 IpcBridge 实现）推送事件，
 * 因此可在 Node 中以 LoopbackChannel 完整测试（M11 L2 E2E）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CreatedEngine,
  type Session,
  SessionStore,
  createEngineAsync,
} from '@mozi/core';
import type { ProviderRegistry } from '@mozi/providers';
import type { AgentEvent, CostLimits, PolicyMode, RunInput, SessionConfig } from '@mozi/shared';
import type {
  ApprovalTicketView,
  DashboardStats,
  RunStartResponse,
  SessionState,
  SessionSummary,
} from '@mozi/protocol';

/** 每会话池条目。 */
interface PoolEntry {
  sessionId: string;
  workspaceRoot: string;
  engine: CreatedEngine;
  /** 当前运行状态（供 session:status 推送）。 */
  state: SessionState;
  /** 进行中的轮次中止控制器（abort 用）。 */
  running: boolean;
  /** 窗口已关闭后是否继续后台运行（§10.4 默认开）。 */
  background: boolean;
  /** 打开该会话的窗口 id 集合（多窗口聚焦判定）。 */
  windows: Set<string>;
  /** 待处理审批票据（UI 重连后回放）。 */
  pendingApprovals: ApprovalTicketView[];
  createdAt: string;
}

export interface AgentServiceOptions {
  /** 会话持久化根目录（默认 ~/.mozi/sessions）。 */
  sessionDir?: string;
  /** provider 注册表（主进程持有；密钥不进渲染进程）。 */
  providers: ProviderRegistry;
  /** Provider 别名：会话 executor 名 → registry 中的 provider id。 */
  providerAlias?: (model: string) => string;
  /** 默认策略模式。 */
  policyMode?: PolicyMode;
  /**
   * 事件出口：所有会话事件经此推送（由 IpcBridge 转发到 webContents / send）。
   * 子智能体审批冒泡依赖此通道 —— 父 run() 生成器等待工具执行期间无法 yield。
   */
  emit: (event: AgentEvent) => void;
  /** 会话状态变更出口（session:status）。 */
  emitStatus?: (sessionId: string, state: SessionState) => void;
  /** 系统提示覆盖。 */
  systemPrompt?: string;
  /** 沙箱等级。 */
  sandboxLevel?: 0 | 1 | 2 | 3;
  /** 是否启用子智能体（默认 true）。 */
  enableSubAgents?: boolean;
  /** 成本上限（注入后引擎每 turn.completed 评估并发出 cost.warning）。 */
  costLimits?: CostLimits;
}

/** 会话项目名：取 workspace 末段。 */
function projectName(workspaceRoot: string): string {
  const base = path.basename(path.resolve(workspaceRoot));
  return base || workspaceRoot;
}

export class AgentService {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly store: SessionStore;
  private readonly sessionDir: string;
  private runSeq = 0;
  private sessionSeq = 0;

  constructor(private readonly opts: AgentServiceOptions) {
    this.sessionDir = opts.sessionDir ?? path.join(os.homedir(), '.mozi', 'sessions');
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.store = new SessionStore(this.sessionDir);
  }

  /** 会话列表（侧栏，§10.5①）：磁盘会话 + 内存池状态合并。 */
  list(): SessionSummary[] {
    const onDisk = this.store.list();
    const byId = new Map<string, SessionSummary>();
    for (const s of onDisk) {
      byId.set(s.id, {
        id: s.id,
        updatedAt: s.updatedAt,
        model: s.model,
        state: 'idle',
        project: this.projectOf(s.id),
      });
    }
    for (const [id, entry] of this.pool) {
      const prev = byId.get(id);
      byId.set(id, {
        id,
        updatedAt: prev?.updatedAt,
        model: prev?.model,
        workspace: entry.workspaceRoot,
        project: projectName(entry.workspaceRoot),
        state: entry.state,
        usage: entry.engine.engine.getSnapshot(id)?.usage,
      });
    }
    return [...byId.values()].sort((a, b) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
  }

  private projectOf(sessionId: string): string | undefined {
    try {
      const metaPath = path.join(this.sessionDir, sessionId, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return meta.workspace ? projectName(String(meta.workspace)) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 创建会话（§10.3 session:create）。 */
  async create(req: {
    sessionId?: string;
    workspaceRoot: string;
    config?: Partial<SessionConfig>;
  }): Promise<SessionSummary> {
    const sessionId = req.sessionId ?? `sess-${Date.now().toString(36)}-${++this.sessionSeq}`;
    const entry = await this.ensurePool(sessionId, req.workspaceRoot, req.config);
    return {
      id: sessionId,
      workspace: entry.workspaceRoot,
      project: projectName(entry.workspaceRoot),
      state: entry.state,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 恢复会话（§10.3 session:resume）：无则返回 null。 */
  async resume(sessionId: string): Promise<SessionSummary | null> {
    if (this.pool.has(sessionId)) {
      const e = this.pool.get(sessionId)!;
      return { id: sessionId, workspace: e.workspaceRoot, state: e.state };
    }
    const dir = path.join(this.sessionDir, sessionId);
    if (!fs.existsSync(path.join(dir, 'events.jsonl'))) return null;
    let workspaceRoot = process.cwd();
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      if (meta.workspace) workspaceRoot = String(meta.workspace);
    } catch {
      /* fallback cwd */
    }
    const entry = await this.ensurePool(sessionId, workspaceRoot);
    return {
      id: sessionId,
      workspace: workspaceRoot,
      project: projectName(workspaceRoot),
      state: entry.state,
    };
  }

  /** 分叉会话（§10.3 session:fork）。 */
  async fork(sessionId: string, atEventIndex?: number): Promise<SessionSummary> {
    const forked = this.store.fork(sessionId, atEventIndex);
    return {
      id: forked.id,
      workspace: this.projectOf(sessionId),
      state: 'idle',
      updatedAt: new Date().toISOString(),
    };
  }

  /** 删除会话（§10.3 session:delete）。 */
  async delete(sessionId: string): Promise<{ ok: boolean }> {
    const entry = this.pool.get(sessionId);
    if (entry) {
      entry.engine.engine.abort(sessionId, 'session_deleted');
      await entry.engine.dispose();
      this.pool.delete(sessionId);
    }
    try {
      fs.rmSync(path.join(this.sessionDir, sessionId), { recursive: true, force: true });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** 启动一轮任务（§10.3 run:start）：立即返回 runId，事件后台推送。 */
  start(req: { sessionId: string; text: string; overrides?: Partial<SessionConfig> }): RunStartResponse {
    const entry = this.pool.get(req.sessionId);
    if (!entry) {
      return {
        runId: '',
        accepted: false,
        error: { code: 'ERR_SESSION_NOT_FOUND', message: `session not found: ${req.sessionId}` },
      };
    }
    if (entry.running) {
      return {
        runId: '',
        accepted: false,
        error: { code: 'ERR_SESSION_BUSY', message: 'session is busy' },
      };
    }
    const runId = `run-${Date.now().toString(36)}-${++this.runSeq}`;
    entry.running = true;
    this.setState(entry, 'running');

    const input: RunInput = { sessionId: req.sessionId, text: req.text };
    if (req.overrides) input.overrides = req.overrides;

    // 后台推进：不 await，事件经 emit 推送（§10.4 窗口关闭 ≠ 停止）。
    void this.drive(entry, input);
    return { runId, accepted: true };
  }

  /** 消费引擎事件流：转发 + 状态机维护。 */
  private async drive(entry: PoolEntry, input: RunInput): Promise<void> {
    const sid = entry.sessionId;
    try {
      for await (const ev of entry.engine.engine.run(input)) {
        this.opts.emit(this.stamp(sid, ev));
        if (ev.type === 'tool.approval.required') {
          this.setState(entry, 'pending_approval');
          if (!entry.pendingApprovals.some((p) => p.callId === ev.call.id)) {
            entry.pendingApprovals.push({
              callId: ev.call.id,
              sessionId: sid,
              call: ev.call,
              reason: ev.reason,
            });
          }
        } else if (ev.type === 'tool.approval.resolved') {
          entry.pendingApprovals = entry.pendingApprovals.filter((p) => p.callId !== ev.callId);
          if (entry.pendingApprovals.length === 0 && entry.running) this.setState(entry, 'running');
        } else if (ev.type === 'task.completed') {
          this.setState(entry, ev.reason === 'model_finished' ? 'completed' : 'idle');
        } else if (ev.type === 'error') {
          this.setState(entry, 'failed');
        }
      }
    } catch (err) {
      this.opts.emit({
        type: 'error',
        sessionId: sid,
        error: {
          code: 'ERR_DESKTOP_RUN',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
        },
        recoverable: true,
        ts: new Date().toISOString(),
      } as AgentEvent);
      this.setState(entry, 'failed');
    } finally {
      entry.running = false;
      if (entry.state === 'running' || entry.state === 'pending_approval') {
        this.setState(entry, 'idle');
      }
    }
  }

  /** 裁决审批（§10.3 approval:resolve）。子智能体审批同样经此路由。 */
  resolveApproval(req: {
    sessionId: string;
    callId: string;
    decision: 'allow' | 'deny';
    onceForSession?: boolean;
  }): { ok: boolean } {
    const entry = this.pool.get(req.sessionId);
    if (!entry) return { ok: false };
    entry.engine.engine.resolveApproval(req.sessionId, req.callId, req.decision);
    // 不再手动 emit `tool.approval.resolved`：引擎在 executeOne 放行后会自行
    // 产出该事件（经宿主通道实时上抛 + 生成器），此处重复发会导致 UI 收到双份。
    entry.pendingApprovals = entry.pendingApprovals.filter((p) => p.callId !== req.callId);
    return { ok: true };
  }

  /** 中止（§10.3 engine:abort）：级联取消子智能体子树。 */
  abort(req: { sessionId: string; reason?: string }): { ok: boolean } {
    const entry = this.pool.get(req.sessionId);
    if (!entry) return { ok: false };
    entry.engine.engine.abort(req.sessionId, req.reason ?? 'user_interrupt');
    return { ok: true };
  }

  /** 待处理审批（UI 重连回放）。 */
  pendingApprovals(sessionId: string): ApprovalTicketView[] {
    return this.pool.get(sessionId)?.pendingApprovals ?? [];
  }

  /** 会话是否正在运行（后台运行指示）。 */
  isRunning(sessionId: string): boolean {
    return this.pool.get(sessionId)?.running ?? false;
  }

  /** 会话的引擎（供 diff 部分应用 / 子智能体查询等高级操作）。 */
  engineFor(sessionId: string): CreatedEngine | undefined {
    return this.pool.get(sessionId)?.engine;
  }

  /** 注册窗口（多窗口共享会话，§10.4）。返回是否需要聚焦已有窗口。 */
  attachWindow(sessionId: string, windowId: string): { alreadyOpen: boolean; focus: string | null } {
    const entry = this.pool.get(sessionId);
    if (!entry) return { alreadyOpen: false, focus: null };
    const existed = entry.windows.size > 0;
    const first = entry.windows.values().next().value as string | undefined;
    entry.windows.add(windowId);
    return { alreadyOpen: existed, focus: existed ? (first ?? null) : null };
  }

  detachWindow(sessionId: string, windowId: string): void {
    const entry = this.pool.get(sessionId);
    if (!entry) return;
    entry.windows.delete(windowId);
    // 窗口全关但 background=true：引擎继续跑完当前 turn（§10.4）。
  }

  /** 「后台运行」开关（§10.4，默认开）。 */
  setBackground(sessionId: string, enabled: boolean): void {
    const entry = this.pool.get(sessionId);
    if (entry) entry.background = enabled;
  }

  /** 仪表盘聚合（§10.5⑤）：从所有会话事件流统计。 */
  dashboard(): DashboardStats {
    const tokensByDay = new Map<string, { input: number; output: number }>();
    const toolCalls = new Map<string, number>();
    const approvals = { allow: 0, deny: 0 };
    const costByModel = new Map<string, number>();
    for (const item of this.store.list()) {
      const events = readEvents(path.join(this.sessionDir, item.id, 'events.jsonl'));
      for (const ev of events) {
        if (ev.type === 'turn.completed' || ev.type === 'token.usage') {
          const day = ev.ts.slice(0, 10);
          const acc = tokensByDay.get(day) ?? { input: 0, output: 0 };
          acc.input += ev.usage?.inputTokens ?? 0;
          acc.output += ev.usage?.outputTokens ?? 0;
          tokensByDay.set(day, acc);
          if (ev.usage?.costUsd) {
            costByModel.set(ev.usage.model, (costByModel.get(ev.usage.model) ?? 0) + ev.usage.costUsd);
          }
        } else if (ev.type === 'tool.requested') {
          toolCalls.set(ev.call.name, (toolCalls.get(ev.call.name) ?? 0) + 1);
        } else if (ev.type === 'tool.approval.resolved') {
          if (ev.decision === 'allow') approvals.allow++;
          else approvals.deny++;
        }
      }
    }
    return {
      tokensByDay: [...tokensByDay.entries()]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      toolCalls: [...toolCalls.entries()].map(([name, count]) => ({ name, count })),
      approvals,
      costByModel: [...costByModel.entries()].map(([model, costUsd]) => ({ model, costUsd })),
    };
  }

  /** 审计查询（§10.3 audit:query）：从会话事件流过滤审批记录。 */
  audit(req: {
    since?: string;
    until?: string;
    filters?: { sessionId?: string; tool?: string; decision?: 'allow' | 'deny' };
  }): Array<{
    ts: string;
    sessionId: string;
    tool: string;
    callId: string;
    decision: 'allow' | 'deny';
    by: 'user' | 'policy';
  }> {
    const out: Array<{
      ts: string;
      sessionId: string;
      tool: string;
      callId: string;
      decision: 'allow' | 'deny';
      by: 'user' | 'policy';
    }> = [];
    const sessions = req.filters?.sessionId ? [req.filters.sessionId] : this.store.list().map((s) => s.id);
    for (const sid of sessions) {
      const events = readEvents(path.join(this.sessionDir, sid, 'events.jsonl'));
      const callNames = new Map<string, string>();
      for (const ev of events) {
        if (ev.type === 'tool.requested') callNames.set(ev.call.id, ev.call.name);
        if (ev.type === 'tool.approval.resolved') {
          if (req.since && ev.ts < req.since) continue;
          if (req.until && ev.ts > req.until) continue;
          if (req.filters?.decision && ev.decision !== req.filters.decision) continue;
          const tool = callNames.get(ev.callId) ?? '?';
          if (req.filters?.tool && tool !== req.filters.tool) continue;
          out.push({ ts: ev.ts, sessionId: sid, tool, callId: ev.callId, decision: ev.decision, by: ev.by });
        }
      }
    }
    return out.sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** 优雅退出（§10.4）：全部会话 flush + abort，10s 上限。 */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const work = (async () => {
      for (const [sid, entry] of this.pool) {
        this.abort({ sessionId: sid, reason: 'shutdown' });
        await entry.engine.dispose();
      }
      this.opts.emit({
        type: 'session.terminated',
        sessionId: '*',
        reason: 'shutdown',
        ts: new Date().toISOString(),
      });
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private setState(entry: PoolEntry, state: SessionState): void {
    entry.state = state;
    this.opts.emitStatus?.(entry.sessionId, state);
  }

  /**
   * 给引擎事件打上归属会话 id（若无）。
   *
   * 引擎的多数事件（turn.started / message.* / tool.* 等）**不带 sessionId**
   * —— 单会话时无需。但桌面是多会话并行，事件必须能分桶到具体会话，
   * 否则 IpcBridge 会归到 `'*'`，UI store 也就把多会话事件混到一个视图里。
   * 子智能体事件自带 subSessionId/parentSessionId（不覆盖），只补主事件。
   */
  private stamp(sessionId: string, event: AgentEvent): AgentEvent {
    const ev = event as unknown as Record<string, unknown>;
    if (typeof ev.sessionId === 'string') return event;
    // 子智能体事件已能解析归属（parentSessionId），保持原样交由 resolveSessionId 处理。
    if (typeof ev.parentSessionId === 'string') return event;
    return { ...(event as object), sessionId } as AgentEvent;
  }

  /** 确保会话在池中（惰性构造引擎）。 */
  private async ensurePool(
    sessionId: string,
    workspaceRoot: string,
    config?: Partial<SessionConfig>,
  ): Promise<PoolEntry> {
    const existing = this.pool.get(sessionId);
    if (existing) return existing;
    const created = await createEngineAsync({
      sessionDir: this.sessionDir,
      workspaceRoot,
      providers: this.opts.providers,
      policyMode: this.opts.policyMode ?? 'auto',
      systemPrompt: this.opts.systemPrompt,
      sandboxLevel: this.opts.sandboxLevel,
      enableSubAgents: this.opts.enableSubAgents,
      costLimits: this.opts.costLimits,
      // 子智能体桥接事件 / 审批事件经宿主通道即时送达（M12 §12.8）。
      // 审批事件在 executeOne 阻塞前上抛，此处立刻登记 pending，
      // 使 UI 能在生成器仍在等待审批时调用 resolveApproval。
      // 注意：hostSink 传出的原始事件**不带 sessionId**（由 drive.stamp 追加），
      // 因此这里必须用闭包捕获的 sessionId 补上，UI 才能据 sessionId 路由 resolve。
      onEvent: (ev) => {
        if (ev.type === 'tool.approval.required') {
          const stamped = this.stamp(sessionId, ev);
          const e = this.pool.get(sessionId);
          if (e && !e.pendingApprovals.some((p) => p.callId === ev.call.id)) {
            e.pendingApprovals.push({
              callId: ev.call.id,
              sessionId,
              call: ev.call,
              reason: ev.reason,
            });
            this.setState(e, 'pending_approval');
          }
          this.opts.emit(stamped);
          return;
        }
        if (ev.type === 'tool.approval.resolved') {
          const e = this.pool.get(sessionId);
          if (e) {
            e.pendingApprovals = e.pendingApprovals.filter((p) => p.callId !== ev.callId);
          }
          this.opts.emit(this.stamp(sessionId, ev));
          return;
        }
        this.opts.emit(ev);
      },
    });
    void config;
    const entry: PoolEntry = {
      sessionId,
      workspaceRoot,
      engine: created,
      state: 'idle',
      running: false,
      background: true,
      windows: new Set(),
      pendingApprovals: [],
      createdAt: new Date().toISOString(),
    };
    this.pool.set(sessionId, entry);
    return entry;
  }

  /** 已加载会话数（诊断）。 */
  get poolSize(): number {
    return this.pool.size;
  }

  /** 会话快照（含 Session 对象，供 diff 部分应用等）。 */
  sessionOf(sessionId: string): Session | undefined {
    return this.store.loadOrCreate(sessionId);
  }
}

function readEvents(file: string): AgentEvent[] {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').map((l) => JSON.parse(l) as AgentEvent);
  } catch {
    return [];
  }
}
