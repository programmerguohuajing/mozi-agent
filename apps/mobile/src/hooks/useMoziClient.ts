import type { DevicePermissions, RemotePush, SessionState, SessionSummary } from '@mozi/protocol';
import type { AgentEvent, ApprovalReason, TokenUsage } from '@mozi/shared';
/**
 * useMoziClient：移动端远程客户端单例 store + React 绑定（M4.75 / M14 §14.8）。
 *
 * 设计要点：
 *  - 单例 store（非 Context）：App 与五个页面共享同一条 WSS 连接与缓存快照；
 *  - useSyncExternalStore：快照为不可变引用，仅 set 时重渲染；
 *  - 配对成功后 deviceId/token 持久化（web: localStorage；native 平台后续接 AsyncStorage），
 *    下次启动可免配对码直接走 auth 重连（§14.4）；
 *  - 推送事件落缓存：engine:event → 事件流/审批票据；session:status → 会话状态与 busy 位。
 */
import React from 'react';
import type { ClientConnState, DevicePageItem, TaskPageItem } from '../client';
import { MobileRemoteClient, WssTransport } from '../transport';

/** 审批票据（收件箱条目；risk 与 @mozi/protocol ApprovalRisk 对齐）。 */
export interface ApprovalTicket {
  callId: string;
  sessionId: string;
  callName: string;
  summary: string;
  risk: 'safe' | 'side-effect' | 'network' | 'high';
  /** 来自子智能体时非空（§12.7 冒泡）。 */
  agentType?: string;
  /** null = 待处理；allow/deny = 已决。 */
  decision: 'allow' | 'deny' | null;
  ts: number;
}

/** 会话事件流渲染项。 */
export interface SessionEventItem {
  seq: number;
  sessionId: string;
  event: AgentEvent;
}

export interface MoziClientSnapshot {
  connState: ClientConnState;
  connected: boolean;
  busy: boolean;
  deviceId: string | null;
  deviceName: string;
  error: string | null;
  permissions: DevicePermissions | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  events: SessionEventItem[];
  approvals: ApprovalTicket[];
  tasks: TaskPageItem[];
  devices: DevicePageItem[];
}

const EVENTS_MAX = 300;
const DEFAULT_URL = 'ws://localhost:8787';

// ── 持久化（web: localStorage；native 运行时无 localStorage 则跳过）────

interface SavedCredential {
  url: string;
  deviceId: string;
  token: string;
  deviceName: string;
}

function loadSaved(): SavedCredential | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem('mozi.device');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedCredential>;
    if (!parsed.url || !parsed.deviceId || !parsed.token) return null;
    return {
      url: parsed.url,
      deviceId: parsed.deviceId,
      token: parsed.token,
      deviceName: parsed.deviceName ?? 'Mozi 移动端',
    };
  } catch {
    return null;
  }
}

function saveSaved(cred: SavedCredential | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (cred) localStorage.setItem('mozi.device', JSON.stringify(cred));
    else localStorage.removeItem('mozi.device');
  } catch {
    /* 存储不可用：忽略 */
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────

/** 工具参数 → 单行摘要（收件箱展示用）。 */
function summarizeArgs(args: unknown): string {
  try {
    if (args === null || args === undefined) return '';
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 110 ? `${one.slice(0, 110)}…` : one;
  } catch {
    return '';
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mi}`;
  } catch {
    return '';
  }
}

export { fmtTime };

/** 审批风险等级（§14.5 / 与 M6 RiskAnalyzer 输出对齐）。 */
export type ApprovalRiskLevel = 'safe' | 'side-effect' | 'network' | 'high';

const RISK_ORDER: Record<ApprovalRiskLevel, number> = {
  safe: 0,
  'side-effect': 1,
  network: 2,
  high: 3,
};

/** 从审批理由提取风险：risk 类取命今分段最高级；policy/manual 类按 side-effect 处理。 */
function riskFromReason(reason: ApprovalReason): ApprovalRiskLevel {
  if (reason.kind === 'risk') {
    return reason.segments.reduce<ApprovalRiskLevel>(
      (acc, seg) => (RISK_ORDER[seg.risk] > RISK_ORDER[acc] ? seg.risk : acc),
      'safe',
    );
  }
  return 'side-effect';
}

// ── 单例 store ───────────────────────────────────────────────────────

class MoziClientStore {
  private snapshot: MoziClientSnapshot = {
    connState: 'disconnected',
    connected: false,
    busy: false,
    deviceId: null,
    deviceName: loadSaved()?.deviceName ?? 'Mozi 移动端',
    error: null,
    permissions: null,
    sessions: [],
    activeSessionId: null,
    events: [],
    approvals: [],
    tasks: [],
    devices: [],
  };
  private listeners = new Set<() => void>();
  private client: MobileRemoteClient | null = null;
  private transport: WssTransport | null = null;
  private url = DEFAULT_URL;

  // useSyncExternalStore 绑定（保持稳定引用）
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getSnapshot = (): MoziClientSnapshot => this.snapshot;

  get state(): MoziClientSnapshot {
    return this.snapshot;
  }
  get deviceId(): string | null {
    return this.snapshot.deviceId;
  }

  private set(patch: Partial<MoziClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ── 连接管理 ──────────────────────────────────────────────────────

  private buildClient(
    url: string,
    deviceName: string,
  ): { transport: WssTransport; client: MobileRemoteClient } {
    const transport = new WssTransport(url);
    const client = new MobileRemoteClient(transport, {
      deviceName,
      platform:
        typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
          ? 'android'
          : 'web',
      pubKey: 'pending-e2e-key', // E2E 密钥协商（crypto-box）后续里程碑接入
    });
    client.onPush((frame) => this.handlePush(frame));
    return { transport, client };
  }

  /** 配对 → 认证 → 拉取列表（首次连接）。 */
  async connect(opts: { url: string; pairingCode: string; deviceName: string }): Promise<void> {
    this.set({ error: null });
    const { transport, client } = this.buildClient(opts.url, opts.deviceName);
    await client.connect({ pairingCode: opts.pairingCode });
    const cred = client.currentDevice();
    if (!cred) throw new Error('配对未返回设备凭证');
    await client.auth(cred.deviceId, cred.token);
    this.client = client;
    this.transport = transport;
    this.url = opts.url;
    saveSaved({
      url: opts.url,
      deviceId: cred.deviceId,
      token: cred.token,
      deviceName: opts.deviceName,
    });
    this.set({
      connState: 'connected',
      connected: true,
      deviceId: cred.deviceId,
      deviceName: opts.deviceName,
      permissions: (client.currentPermissions() as DevicePermissions) ?? null,
    });
    await this.refresh();
  }

  /** 免配对码重连（已保存凭证走 auth 流程，§14.4）。 */
  async reconnect(): Promise<void> {
    const saved = loadSaved();
    if (!saved) throw new Error('无已保存的设备凭证');
    this.set({ error: null });
    const { transport, client } = this.buildClient(saved.url, saved.deviceName);
    await transport.connect();
    await client.auth(saved.deviceId, saved.token);
    this.client = client;
    this.transport = transport;
    this.url = saved.url;
    this.set({
      connState: 'connected',
      connected: true,
      deviceId: saved.deviceId,
      deviceName: saved.deviceName,
      permissions: (client.currentPermissions() as DevicePermissions) ?? null,
    });
    await this.refresh();
  }

  hasSavedCredentials(): boolean {
    return loadSaved() !== null;
  }

  /** 断开并遗忘本设备凭证（设备页「退出」用）。 */
  logout(): void {
    this.transport?.close();
    this.client = null;
    this.transport = null;
    saveSaved(null);
    this.set({
      connState: 'disconnected',
      connected: false,
      busy: false,
      deviceId: null,
      permissions: null,
      sessions: [],
      activeSessionId: null,
      events: [],
      approvals: [],
      tasks: [],
      devices: [],
      error: null,
    });
  }

  /** 刷新会话 / 任务 / 设备三张列表。 */
  async refresh(): Promise<void> {
    if (!this.client) return;
    const [sessions, tasks, devices] = await Promise.all([
      this.client.invoke<SessionSummary[]>('session:list', {}).catch(() => [] as SessionSummary[]),
      this.client.invoke<TaskPageItem[]>('task:list', {}).catch(() => [] as TaskPageItem[]),
      this.client.invoke<DevicePageItem[]>('device:list', {}).catch(() => [] as DevicePageItem[]),
    ]);
    this.set({ sessions, tasks, devices });
  }

  // ── 会话 ──────────────────────────────────────────────────────────

  /** 订阅会话事件流（断线重连带 lastEventId 续传，§14.3）。 */
  async attachSession(sessionId: string): Promise<void> {
    if (!this.client) return;
    const last =
      this.snapshot.events.length > 0
        ? this.snapshot.events[this.snapshot.events.length - 1]?.seq
        : undefined;
    await this.client.attach(sessionId, last);
    this.set({ activeSessionId: sessionId, events: [] });
  }

  closeSessionView(): void {
    this.set({ activeSessionId: null });
  }

  /** 下发任务（run:start 为幂等通道，requestId 防弱网重放）。 */
  async sendMessage(text: string): Promise<void> {
    if (!this.client || !this.snapshot.activeSessionId) return;
    await this.client.invoke(
      'run:start',
      {
        sessionId: this.snapshot.activeSessionId,
        text,
      },
      `run-${Date.now()}`,
    );
    this.set({ busy: true });
  }

  async abortRun(): Promise<void> {
    if (!this.client || !this.snapshot.activeSessionId) return;
    await this.client.invoke('engine:abort', { sessionId: this.snapshot.activeSessionId });
  }

  // ── 审批（§14.5：high 级服务端只允许 defer）────────────────────────

  async resolveApproval(ticket: ApprovalTicket, decision: 'allow' | 'deny'): Promise<void> {
    if (!this.client) return;
    // 乐观更新：按钮即时反馈；服务端拒绝（如 ERR_DEFER）时回滚。
    const prev = this.snapshot.approvals;
    this.set({
      approvals: prev.map((t) => (t.callId === ticket.callId ? { ...t, decision } : t)),
    });
    try {
      await this.client.invoke('approval:resolve', {
        sessionId: ticket.sessionId,
        callId: ticket.callId,
        decision,
        risk: ticket.risk,
      });
    } catch (e) {
      this.set({ approvals: prev, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  // ── 定时任务 ──────────────────────────────────────────────────────

  async runTask(taskId: string): Promise<void> {
    if (!this.client) return;
    await this.client.invoke('task:run', { taskId });
    await this.refresh();
  }

  async setTaskEnabled(taskId: string, enabled: boolean): Promise<void> {
    if (!this.client) return;
    await this.client.invoke(enabled ? 'task:enable' : 'task:disable', { taskId });
    await this.refresh();
  }

  // ── 设备管理 ──────────────────────────────────────────────────────

  async renameDevice(deviceId: string, name: string): Promise<void> {
    if (!this.client) return;
    await this.client.invoke('device:rename', { deviceId, name });
    await this.refresh();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.client) return;
    await this.client.invoke('device:revoke', { deviceId });
    await this.refresh();
  }

  // ── 推送处理 ──────────────────────────────────────────────────────

  private handlePush(frame: RemotePush): void {
    if (frame.t === 'revoked') {
      this.transport?.close();
      this.client = null;
      this.transport = null;
      saveSaved(null);
      this.set({
        connState: 'revoked',
        connected: false,
        busy: false,
        error: `设备已被吊销：${frame.reason}`,
      });
      return;
    }
    if (frame.t !== 'push') return;

    if (frame.channel === 'engine:event') {
      this.applyEngineEvent(frame.sessionId ?? '', frame.payload);
    } else if (frame.channel === 'session:status') {
      this.applySessionStatus(frame.payload);
    }
  }

  /** engine:event 载荷兼容两种形态：远程节点直发事件本体 / 桌面桥接包 {sessionId,event}。 */
  private applyEngineEvent(frameSessionId: string, payload: unknown): void {
    let sessionId = frameSessionId;
    let event: AgentEvent;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'event' in payload &&
      typeof (payload as { event?: { type?: unknown } }).event?.type === 'string'
    ) {
      const wrapped = payload as { sessionId?: unknown; event: AgentEvent };
      if (typeof wrapped.sessionId === 'string') sessionId = wrapped.sessionId;
      event = wrapped.event;
    } else {
      event = payload as AgentEvent;
    }

    // 事件流（仅当前订阅会话）
    if (this.snapshot.activeSessionId === sessionId) {
      const seq = Date.now();
      const events = [...this.snapshot.events, { seq, sessionId, event }];
      if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
      let busy = this.snapshot.busy;
      if (event.type === 'turn.started' || event.type === 'tool.started') busy = true;
      if (
        event.type === 'task.completed' ||
        event.type === 'session.terminated' ||
        event.type === 'error'
      ) {
        busy = false;
      }
      this.set({ events, busy });
    }

    // 审批票据（tool.approval.required / subagent.approval.required）
    if (event.type === 'tool.approval.required' || event.type === 'subagent.approval.required') {
      const ticket: ApprovalTicket = {
        callId: event.type === 'subagent.approval.required' ? event.callId : event.call.id,
        sessionId,
        callName: event.call.name,
        summary: summarizeArgs(event.call.arguments),
        risk: riskFromReason(event.reason),
        decision: null,
        ts: Date.now(),
        ...(event.type === 'subagent.approval.required' ? { agentType: event.agentType } : {}),
      };
      this.set({
        approvals: [ticket, ...this.snapshot.approvals.filter((t) => t.callId !== ticket.callId)],
      });
    } else if (event.type === 'tool.approval.resolved') {
      this.set({
        approvals: this.snapshot.approvals.map((t) =>
          t.callId === event.callId ? { ...t, decision: event.decision } : t,
        ),
      });
    }
  }

  private applySessionStatus(payload: unknown): void {
    const p = payload as { sessionId?: string; state?: SessionState; usage?: TokenUsage };
    if (!p || typeof p.sessionId !== 'string' || typeof p.state !== 'string') return;
    this.set({
      sessions: this.snapshot.sessions.map((s) =>
        s.id === p.sessionId ? { ...s, state: p.state!, usage: p.usage ?? s.usage } : s,
      ),
      busy: p.state === 'running' || p.state === 'pending_approval',
    });
  }
}

export const moziClient = new MoziClientStore();

/** React 绑定：订阅单例快照并返回 store（App 与页面共用）。 */
export function useMoziClient(): MoziClientStore {
  React.useSyncExternalStore(moziClient.subscribe, moziClient.getSnapshot);
  return moziClient;
}
