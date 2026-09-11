/**
 * 中继服务器（M4.75 / M14 §14.9）：零内容路由器 + 在线状态 + 推送网关。
 * 职责：按 deviceId/nodeId 寻址路由加密信封；不持业务密钥、不可读内容；
 * 日志只记录路由计数/时长/长度（默认），可整体关闭。
 */
import type { Envelope } from '@mozi/protocol';

export interface RelayPeer {
  /** 设备或节点 id。 */
  id: string;
  /** 在线回调：把信封交给对端。 */
  deliver(envelope: Envelope): void;
  /** 对端离线的推送网关（可选）。 */
  push?: PushGatewayLike;
}

export interface PushGatewayLike {
  /** 零内容唤醒（§14.7：只携带 {type, sessionId, ts}）。 */
  notify(type: string, sessionId: string): Promise<void> | void;
}

export interface RelayLogEntry {
  ts: string;
  from: string;
  to: string;
  len: number;
}

export interface RelayRouteResult {
  delivered: boolean;
  peerOnline: boolean;
  /** 离线时是否已转推送唤醒。 */
  pushed: boolean;
}

export interface RelayRouterOptions {
  /** 日志开关：false 时完全不记录任何路由明细（§14.9 不可枚举）。 */
  logging?: boolean;
  clock?: () => Date;
}

/**
 * 中继路由核心（与具体传输无关）：内存 peer 表 + 信封转发 + 离线推送 + 日志。
 */
export class RelayRouter {
  private readonly peers = new Map<string, RelayPeer>();
  private readonly logEntries: RelayLogEntry[] = [];
  private readonly logEnabled: boolean;
  private readonly clock: () => Date;

  constructor(opts: RelayRouterOptions = {}) {
    this.logEnabled = opts.logging ?? false;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** 注册在线对端（设备/节点连接时）。 */
  register(peer: RelayPeer): void {
    this.peers.set(peer.id, peer);
  }

  unregister(id: string): void {
    this.peers.delete(id);
  }

  isOnline(id: string): boolean {
    return this.peers.has(id);
  }

  onlineIds(): string[] {
    return [...this.peers.keys()];
  }

  /** 路由信封：目标在线 → deliver；离线 → 若有 push 网关则触发零内容唤醒。 */
  route(envelope: Envelope): RelayRouteResult {
    const target = this.peers.get(envelope.to);
    if (target) {
      target.deliver(envelope);
      this.maybeLog(envelope);
      return { delivered: true, peerOnline: true, pushed: false };
    }
    // 离线：只触发唤醒（含 sessionId 供回前台拉取）
    const anyPeer = [...this.peers.values()].find(() => true);
    if (anyPeer?.push) anyPeer.push.notify('wake', envelope.from);
    this.maybeLog(envelope);
    return { delivered: false, peerOnline: false, pushed: !!anyPeer?.push };
  }

  /** 日志（零内容：只有路由头与长度，供运营审计；默认关闭）。 */
  entries(): RelayLogEntry[] {
    return [...this.logEntries];
  }

  loggingEnabled(): boolean {
    return this.logEnabled;
  }

  private maybeLog(envelope: Envelope): void {
    if (!this.logEnabled) return;
    this.logEntries.push({ ts: this.clock().toISOString(), from: envelope.from, to: envelope.to, len: envelope.len });
  }
}

/** 无推送网关（LAN 前台实时；后台无推送，iOS 局限文档说明）。 */
export const EMPTY_PUSH_GATEWAY: PushGatewayLike = {
  notify() {
    /* no-op */
  },
};

/** ntfy 推送网关（自托管 UnifiedPush；零内容唤醒，凭据可选）。 */
export class NtfyPushGateway implements PushGatewayLike {
  constructor(private readonly topic: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async notify(type: string, sessionId: string): Promise<void> {
    const body = JSON.stringify({ type, sessionId });
    try {
      await this.fetchImpl(`https://ntfy.sh/${encodeURIComponent(this.topic)}`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      /* 推送失败不影响路由结果 */
    }
  }
}

/** 中继健康检查（/healthz）。 */
export interface RelayHealth {
  ok: boolean;
  onlinePeers: number;
  uptimeMs: number;
  logEnabled: boolean;
}

export function healthCheck(router: RelayRouter, startedAt: number): RelayHealth {
  return {
    ok: true,
    onlinePeers: router.onlineIds().length,
    uptimeMs: Date.now() - startedAt,
    logEnabled: router.loggingEnabled(),
  };
}