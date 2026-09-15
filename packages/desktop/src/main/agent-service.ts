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
import { type CreatedEngine, type Session, SessionStore, createEngineAsync } from '@mozi/core';
import type { McpServerEntry } from '@mozi/mcp-client';
import type {
  ApprovalTicketView,
  DashboardStats,
  RunStartResponse,
  SessionState,
  SessionSummary,
  WorkspaceEntry,
  WorkspaceListEntriesRequest,
  WorkspaceListEntriesResponse,
} from '@mozi/protocol';
import type { ProviderRegistry } from '@mozi/providers';
import type { AgentEvent, CostLimits, PolicyMode, RunInput, SessionConfig } from '@mozi/shared';
import type { BrowserAccess } from '@mozi/tools';

/** 目录浏览 / @ 搜索时跳过的噪声目录（依赖产物 / VCS 元数据）。 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.turbo',
  '.workbuddy',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.mozi',
  '.trash',
]);

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
  /**
   * MCP server 配置源（会话引擎构造时读取，注入引擎的 McpBridge）。
   * 每次创建引擎前调用 —— 配置编辑后新会话即刻用上最新的 MCP 工具。
   */
  mcpServers?: () => McpServerEntry[];
  /**
   * 会话级浏览器访问（任务浏览器面板）：按 sessionId 取 BrowserService，
   * 注入引擎后 agent 的 browser 工具与用户看到的 webview 操作同一页面。
   */
  browserFor?: (sessionId: string) => BrowserAccess | undefined;
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
        // 渲染端 @ 引用需要 workspace 绝对路径（meta.json；writeWorkspaceMeta 修复后可靠）。
        workspace: this.workspaceOf(s.id),
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
    return [...byId.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
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

  /** 创建会话（§10.3 session:create）。workspaceRoot 可省略（新建任务不再先选文件夹）。 */
  async create(req: {
    sessionId?: string;
    workspaceRoot?: string;
    config?: Partial<SessionConfig>;
  }): Promise<SessionSummary> {
    const sessionId = req.sessionId ?? `sess-${Date.now().toString(36)}-${++this.sessionSeq}`;
    const workspaceRoot = req.workspaceRoot?.trim() || os.homedir();
    const entry = await this.ensurePool(sessionId, workspaceRoot, req.config);
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

  /**
   * 历史事件回放（session:resume）：把会话 events.jsonl 全量重放给渲染端，
   * 重建消息列表 / 上下文占用 / 子智能体树（恢复窗口后右侧面板不丢数据）。
   */
  replayEvents(sessionId: string): void {
    const events = readEvents(path.join(this.sessionDir, sessionId, 'events.jsonl'));
    for (const ev of events) {
      const stamped = { ...ev, sessionId } as AgentEvent;
      this.opts.emit(stamped);
    }
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

  /**
   * 更换会话的项目文件夹（输入栏「+」→ 选择项目文件夹）。
   *
   * 引擎的 workspace / 记忆 / 钩子都在构造时绑定目录，因此采用
   * 「销毁旧引擎 → 以新 workspace 重建」的方式；历史对话在 events.jsonl，
   * 重建后 resume 重放不会丢。任务运行中拒绝切换（避免中断进行中的轮次）。
   */
  async setWorkspace(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<{ ok: boolean; summary?: SessionSummary; error?: string }> {
    const root = workspaceRoot.trim();
    if (!root) return { ok: false, error: 'workspace 路径不能为空' };
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(root);
    } catch {
      return { ok: false, error: `目录不存在: ${root}` };
    }
    if (!stat.isDirectory()) return { ok: false, error: `不是目录: ${root}` };

    const entry = this.pool.get(sessionId);
    if (entry) {
      if (entry.running) {
        return { ok: false, error: '任务运行中，无法切换项目文件夹（可先中止）' };
      }
      if (path.resolve(entry.workspaceRoot) === path.resolve(root)) {
        return {
          ok: true,
          summary: {
            id: sessionId,
            workspace: entry.workspaceRoot,
            project: projectName(entry.workspaceRoot),
            state: entry.state,
          },
        };
      }
      await entry.engine.dispose();
      this.pool.delete(sessionId);
    }
    const updated = await this.ensurePool(sessionId, root);
    const summary: SessionSummary = {
      id: sessionId,
      workspace: updated.workspaceRoot,
      project: projectName(updated.workspaceRoot),
      state: updated.state,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, summary };
  }

  /**
   * 会话的 workspace（池内优先，其次读 meta.json）。
   * @ 引用弹层 / skills:list 等需要按会话定位目录。
   */
  workspaceOf(sessionId: string): string | undefined {
    const entry = this.pool.get(sessionId);
    if (entry) return entry.workspaceRoot;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(this.sessionDir, sessionId, 'meta.json'), 'utf8'),
      );
      return typeof meta.workspace === 'string' ? meta.workspace : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 列出 workspace 内的条目（输入框 @ 引用弹层）。
   * - 浏览模式（dir）：列某一级子目录内容，目录在前、字母序；
   * - 搜索模式（query）：递归匹配文件/文件夹名，跳过 node_modules 等噪声目录。
   */
  listEntries(req: WorkspaceListEntriesRequest): WorkspaceListEntriesResponse {
    const root = this.workspaceOf(req.sessionId);
    if (!root) return { ok: false, entries: [], error: '会话不存在或尚未指定 workspace' };
    const query = req.query?.trim();
    if (query) {
      const entries = searchEntries(root, query);
      return { ok: true, entries, workspaceRoot: root };
    }
    const rel = (req.dir ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const target = rel ? path.resolve(root, rel) : path.resolve(root);
    // 越界保护：只允许列 workspace 内的目录。
    if (!isInside(root, target)) return { ok: false, entries: [], error: '路径越界' };
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return { ok: false, entries: [], error: `无法读取目录: ${rel || '.'}` };
    }
    const entries: WorkspaceEntry[] = [];
    for (const d of names) {
      if (d.name.startsWith('.') || IGNORED_DIRS.has(d.name)) continue;
      const isDir = d.isDirectory();
      entries.push({
        name: d.name,
        path: toPosix(path.posix.join(rel, d.name)),
        isDir,
      });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { ok: true, entries: entries.slice(0, 500), workspaceRoot: root };
  }

  /** 启动一轮任务（§10.3 run:start）：立即返回 runId，事件后台推送。 */
  start(req: {
    sessionId: string;
    text: string;
    overrides?: Partial<SessionConfig>;
  }): RunStartResponse {
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

  /**
   * 中止（§10.3 engine:abort）：级联取消子智能体子树。
   * 引擎侧 abort 信号会中断 LLM 流、工具执行与审批等待；
   * 此处同步清空待审批票据（中止后票据已失效，UI 不应再显示）。
   */
  abort(req: { sessionId: string; reason?: string }): { ok: boolean } {
    const entry = this.pool.get(req.sessionId);
    if (!entry) return { ok: false };
    entry.engine.engine.abort(req.sessionId, req.reason ?? 'user_interrupt');
    if (entry.pendingApprovals.length > 0) {
      entry.pendingApprovals = [];
      // 状态从 pending_approval 回落：最终态由事件流（task.completed）确认，
      // 但先解除"等待审批"锁定，UI 立即可交互。
      if (entry.state === 'pending_approval') this.setState(entry, 'running');
    }
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
  attachWindow(
    sessionId: string,
    windowId: string,
  ): { alreadyOpen: boolean; focus: string | null } {
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

  /**
   * 动态更新默认策略模式（§10.5 权限模式切换即时生效）。
   * 影响后续新建引擎的兜底 policy；已有会话由 run:start 注入的
   * overrides.policy 覆盖，无需重建引擎。
   */
  setPolicyMode(mode: PolicyMode): void {
    (this.opts as { policyMode?: PolicyMode }).policyMode = mode;
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
            costByModel.set(
              ev.usage.model,
              (costByModel.get(ev.usage.model) ?? 0) + ev.usage.costUsd,
            );
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
    const sessions = req.filters?.sessionId
      ? [req.filters.sessionId]
      : this.store.list().map((s) => s.id);
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
          out.push({
            ts: ev.ts,
            sessionId: sid,
            tool,
            callId: ev.callId,
            decision: ev.decision,
            by: ev.by,
          });
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
      // MCP：会话引擎启动即连接配置的全部 server（配置源实时读取）。
      mcpServers: this.opts.mcpServers?.(),
      // 任务浏览器面板（BrowserPanel 的 webview）：引擎侧 browser 工具
      // 路由到用户所见页面（browserRegistry.for(sessionId)）。
      browserAccess: this.opts.browserFor?.(sessionId),
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
    // 把真实 workspace 写入 meta.json：core 的 SessionStore.writeMeta 会把
    // workspace 硬编码为 process.cwd()，导致重启 resume 后目录丢失、侧栏分组错乱。
    this.writeWorkspaceMeta(sessionId, workspaceRoot);
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

  /** 把真实 workspace 合并写入会话 meta.json（resume / setWorkspace 后仍能恢复）。 */
  private writeWorkspaceMeta(sessionId: string, workspaceRoot: string): void {
    try {
      const p = path.join(this.sessionDir, sessionId, 'meta.json');
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* 首次创建：meta.json 可能尚不存在 */
      }
      raw.workspace = workspaceRoot;
      raw.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(raw, null, 2));
    } catch {
      /* best-effort：meta 损坏不影响会话运行 */
    }
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

/** 统一路径分隔符为 `/`（mention 插入与展示的一致性）。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** target 是否位于 root 内（含 root 自身）；防目录穿越。 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 递归搜索文件/文件夹名（@xxx 全局搜索模式）。
 * BFS + 噪声目录剪枝；命中上限 MAX_RESULTS 即停，避免大目录卡顿。
 */
function searchEntries(root: string, query: string): WorkspaceEntry[] {
  const q = query.toLowerCase();
  const MAX_RESULTS = 50;
  const MAX_DIRS = 2000;
  const results: WorkspaceEntry[] = [];
  const queue: Array<{ abs: string; rel: string }> = [{ abs: path.resolve(root), rel: '' }];
  let visited = 0;
  while (queue.length > 0 && results.length < MAX_RESULTS && visited < MAX_DIRS) {
    const { abs, rel } = queue.shift()!;
    visited++;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (d.name.startsWith('.') || IGNORED_DIRS.has(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.name.toLowerCase().includes(q)) {
        results.push({ name: d.name, path: toPosix(childRel), isDir: d.isDirectory() });
        if (results.length >= MAX_RESULTS) break;
      }
      if (d.isDirectory()) {
        queue.push({ abs: path.join(abs, d.name), rel: childRel });
      }
    }
  }
  // 目录优先、浅层优先（BFS 天然按深度有序）。
  results.sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1));
  return results;
}
