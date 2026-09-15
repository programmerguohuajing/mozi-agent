import type { SessionState, SessionSummary } from '@mozi/protocol';
/**
 * 渲染进程状态（M10 §10.2 / §10.5）。
 *
 * 订阅 IpcBridge 转发的引擎事件，维护每个会话的 RenderItem 列表、运行状态、
 * 待审批票据、子智能体树、用量。实现为**纯 reducer + 订阅器**（零 React/zustand 依赖），
 * 因此可在 Node 中直接断言（M11 L2「UI 状态与事件流一致」）。
 * React 侧用 `useSyncExternalStore` 订阅本 store。
 */
import type { AgentEvent, TokenUsage } from '@mozi/shared';
import { type RenderItem, eventToRenderItems } from './render-item.js';

export interface SubAgentNode {
  subSessionId: string;
  agentType: string;
  state: 'started' | 'queued' | 'progress' | 'completed' | 'failed';
  step?: number;
  maxSteps?: number;
  currentTool?: string;
  summary?: string;
  error?: string;
}

export interface SessionView {
  id: string;
  state: SessionState;
  items: RenderItem[];
  /** 子智能体树（§10.5⑥）。 */
  subagents: SubAgentNode[];
  pendingApprovals: RenderItem[];
  usage?: TokenUsage;
  /** 上下文占用（context.usage 事件实时更新；右侧面板真实数据源）。 */
  contextUsed?: number;
  contextBudget?: number;
  /** 流式缓冲区（跟随模式）：最后一条 assistant 是否在流式。 */
  streaming: boolean;
}

export interface UiState {
  sessions: SessionSummary[];
  views: Record<string, SessionView>;
  activeSessionId?: string;
  /** 上一次状态变更的会话（供通知 / 跳转）。 */
  lastStatus?: { sessionId: string; state: SessionState };
}

export type Listener = (state: UiState) => void;

export function initialState(): UiState {
  return { sessions: [], views: {} };
}

function emptyView(id: string): SessionView {
  return { id, state: 'idle', items: [], subagents: [], pendingApprovals: [], streaming: false };
}

/** 应用一个引擎事件到某个会话视图（不可变更新）。 */
export function applyEngineEvent(state: UiState, sessionId: string, event: AgentEvent): UiState {
  const view = state.views[sessionId] ?? emptyView(sessionId);
  const next: SessionView = {
    ...view,
    items: [...view.items],
    subagents: [...view.subagents],
    pendingApprovals: [...view.pendingApprovals],
  };

  // ── 流式合并：delta 追加到最后一条 assistant ──
  if (event.type === 'message.delta') {
    const last = next.items[next.items.length - 1];
    if (last && last.kind === 'assistant' && last.streaming) {
      next.items[next.items.length - 1] = { ...last, text: last.text + event.text };
    } else {
      next.items.push({
        kind: 'assistant',
        id: `stream-${next.items.length}`,
        text: event.text,
        streaming: true,
        ts: event.ts,
      });
    }
    next.streaming = true;
    return commit(state, sessionId, next);
  }

  // 收到 completed：关闭前一条流式 assistant，再追加 completed 产出。
  if (event.type === 'message.completed') {
    for (let i = next.items.length - 1; i >= 0; i--) {
      const it = next.items[i]!;
      if (it.kind === 'assistant' && it.streaming) {
        next.items[i] = { ...it, streaming: false };
        break;
      }
    }
    next.streaming = false;
  }

  // ── 工具结果：更新对应 tool 卡 ──
  if (event.type === 'tool.completed') {
    const idx = next.items.findIndex((it) => it.kind === 'tool' && it.callId === event.callId);
    if (idx >= 0) {
      const card = next.items[idx] as Extract<RenderItem, { kind: 'tool' }>;
      next.items[idx] = {
        ...card,
        state: event.result.isError ? 'error' : 'done',
        summary: event.result.content.slice(0, 300),
        ...(event.result.display ? { display: event.result.display } : {}),
      };
    } else {
      next.items.push(...eventToRenderItems(event));
    }
    return commit(state, sessionId, next);
  }

  if (event.type === 'tool.started') {
    const idx = next.items.findIndex((it) => it.kind === 'tool' && it.callId === event.callId);
    if (idx >= 0) {
      const card = next.items[idx] as Extract<RenderItem, { kind: 'tool' }>;
      next.items[idx] = { ...card, state: 'running' };
    }
    return commit(state, sessionId, next);
  }

  // ── 审批票据 ──
  if (event.type === 'tool.approval.required' || event.type === 'subagent.approval.required') {
    // 去重：审批事件同时经宿主实时通道与生成器送达，按 callId 幂等。
    const callId = event.type === 'tool.approval.required' ? event.call.id : event.callId;
    const dup = next.pendingApprovals.some((it) => it.kind === 'approval' && it.callId === callId);
    if (!dup) next.pendingApprovals.push(...eventToRenderItems(event).map((it) => ({ ...it })));
  }
  if (event.type === 'tool.approval.resolved') {
    next.pendingApprovals = next.pendingApprovals.filter(
      (it) => it.kind !== 'approval' || it.callId !== event.callId,
    );
  }

  // ── 子智能体树归并 ──
  if (event.type === 'subagent.started') {
    next.subagents.push({
      subSessionId: event.subSessionId,
      agentType: event.agentType,
      state: 'started',
    });
  } else if (event.type === 'subagent.progress' || event.type === 'subagent.queued') {
    const node = next.subagents.find((s) => s.subSessionId === event.subSessionId);
    if (node) {
      const state = event.type === 'subagent.queued' ? 'queued' : 'progress';
      const merged: SubAgentNode = { ...node, state };
      if (event.type === 'subagent.progress') {
        merged.step = event.step;
        merged.maxSteps = event.maxSteps;
        if (event.currentTool) merged.currentTool = event.currentTool;
      }
      Object.assign(node, merged);
    }
  } else if (event.type === 'subagent.completed') {
    const node = next.subagents.find((s) => s.subSessionId === event.subSessionId);
    if (node) {
      node.state = 'completed';
      node.step = event.steps;
      node.summary = event.summary;
    }
  } else if (event.type === 'subagent.failed') {
    const node = next.subagents.find((s) => s.subSessionId === event.subSessionId);
    if (node) {
      node.state = 'failed';
      node.error = `${event.error.code}: ${event.error.message}`;
    }
  }

  // ── 用量 ──
  // token.usage 是实时增量（turn 进行中也触发），只更新 usage，不改 state；
  // turn.completed 是轮次结束，更新 usage 且置 idle。
  if (event.type === 'turn.completed') {
    next.usage = event.usage;
    next.state = 'idle';
  } else if (event.type === 'token.usage') {
    next.usage = event.usage;
  }

  // ── 上下文占用（右侧面板真实数据源：每轮 step 开始时刷新）──
  if (event.type === 'context.usage') {
    next.contextUsed = event.usedTokens;
    next.contextBudget = event.budgetTokens;
  }

  const produced = eventToRenderItems(event);
  if (produced.length) next.items.push(...produced);

  return commit(state, sessionId, next);
}

/** 会话状态推送（session:status）。 */
export function applySessionStatus(
  state: UiState,
  sessionId: string,
  statusState: SessionState,
): UiState {
  const view = state.views[sessionId] ?? emptyView(sessionId);
  const next: UiState = {
    ...state,
    lastStatus: { sessionId, state: statusState },
    views: { ...state.views, [sessionId]: { ...view, state: statusState } },
    sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, state: statusState } : s)),
  };
  return next;
}

export function applySessionList(state: UiState, sessions: SessionSummary[]): UiState {
  return { ...state, sessions };
}

export function setActive(state: UiState, sessionId: string): UiState {
  return { ...state, activeSessionId: sessionId };
}

function commit(state: UiState, sessionId: string, view: SessionView): UiState {
  return { ...state, views: { ...state.views, [sessionId]: view } };
}

/** 轻量可订阅 store（React 用 useSyncExternalStore 对接）。 */
export class UiStore {
  private state: UiState = initialState();
  private readonly listeners = new Set<Listener>();

  getState(): UiState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn(this.state);
  }

  /** 绑定到 IpcBridge 客户端（channel.on('engine:event') / on('session:status')）。 */
  bind(client: {
    on: (channel: string, listener: (payload: never) => void) => () => void;
  }): () => void {
    const offEvent = client.on('engine:event', (payload: never) => {
      const p = payload as unknown as { sessionId: string; event: AgentEvent };
      this.state = applyEngineEvent(this.state, p.sessionId, p.event);
      this.emit();
    });
    const offStatus = client.on('session:status', (payload: never) => {
      const p = payload as unknown as { sessionId: string; state: SessionState };
      this.state = applySessionStatus(this.state, p.sessionId, p.state);
      this.emit();
    });
    return () => {
      offEvent();
      offStatus();
    };
  }

  setSessions(sessions: SessionSummary[]): void {
    this.state = applySessionList(this.state, sessions);
    this.emit();
  }

  setActive(sessionId: string): void {
    this.state = setActive(this.state, sessionId);
    this.emit();
  }

  apply(sessionId: string, event: AgentEvent): void {
    this.state = applyEngineEvent(this.state, sessionId, event);
    this.emit();
  }

  status(sessionId: string, state: SessionState): void {
    this.state = applySessionStatus(this.state, sessionId, state);
    this.emit();
  }

  /** 视图查询（选择器）。 */
  view(sessionId: string): SessionView | undefined {
    return this.state.views[sessionId];
  }
}
