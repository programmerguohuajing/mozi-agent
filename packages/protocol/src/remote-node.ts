/**
 * 远程节点服务（M4.75 / M14 §14.3/14.6）：认证、权限门禁、幂等、事件扇出、断线重放。
 * 传输无关：WSS 适配器 / 测试 transport 注入同一语义；每连接一个实例，多设备由上层聚合。
 */
import type { DevicePermissions } from './remote.js';
import {
  DeviceRegistry,
  EventLog,
  PairingService,
  RequestDeduper,
  approvalPermitted,
  externalizeAttachment,
  hashToken,
  isIdempotentChannel,
  randomDeviceId,
  randomDeviceToken,
  type ApprovalRisk,
} from './remote.js';
import type { AttachmentRef } from './remote.js';

// ── 帧类型 ────────────────────────────────────────────────────────────

export type RemoteFrame =
  | { t: 'ping' }
  | { t: 'pair'; code: string; deviceName: string; platform: string; pubKey: string }
  | { t: 'auth'; deviceId: string; tokenHash: string }
  | { t: 'invoke'; id: string; channel: string; params: unknown; requestId?: string }
  | { t: 'attach'; sessionId: string; lastEventId?: number }
  | { t: 'fetch'; attachment: string; chunk: number };

export type RemotePush =
  | { t: 'pong' }
  | { t: 'pair-ok'; deviceId: string; token: string; permissions: unknown }
  | { t: 'pair-fail'; error: string }
  | { t: 'auth-ok'; permissions: unknown }
  | { t: 'auth-fail'; error: string }
  | { t: 'res'; id: string; ok: unknown }
  | { t: 'res'; id: string; ok: never; error: { code: string; message: string } }
  | { t: 'push'; channel: string; payload: unknown; seq: number; sessionId?: string }
  | { t: 'attachment'; contentId: string; chunk: number; totalChunks: number; data?: string }
  | { t: 'revoked'; reason: string };

/** 传输抽象（真实 WSS / 测试 transport 均实现）。 */
export interface RemoteTransport {
  send(frame: RemotePush): void;
  close(code?: number, reason?: string): void;
}

export interface InvokeHandlerContext {
  deviceId: string;
  sessionId?: string;
}

export interface RemoteNodeOptions {
  registry: DeviceRegistry;
  pairing: PairingService;
  transport: RemoteTransport;
  /** 附件存储（contentId → 分块元数据）。 */
  attachments?: Map<string, { kind: string; data: string; chunkSize: number }>;
}

const CHANNEL_PERMISSION: Record<string, string> = {
  'session:list': 'viewSessions',
  'session:get': 'viewSessions',
  'session:create': 'sendMessage',
  'session:resume': 'sendMessage',
  'run:start': 'sendMessage',
  'engine:abort': 'sendMessage',
  'approval:resolve': 'approval',
  'task:list': 'viewSessions',
  'task:run': 'triggerTasks',
  'task:enable': 'triggerTasks',
  'task:disable': 'triggerTasks',
  'device:list': 'manageDevices',
  'device:revoke': 'manageDevices',
  'device:rename': 'manageDevices',
  'config:get': 'viewSessions',
  'config:set': 'changePolicy',
  'attachment:fetch': 'viewSessions',
};

/**
 * 远程节点（单连接）：认证 → 权限 → 幂等 → 分发。
 * 事件扇出经 publishEvent / publish；断线重放经 attach。
 */
export class RemoteNode {
  private readonly registry: DeviceRegistry;
  private readonly pairing: PairingService;
  private readonly transport: RemoteTransport;
  private readonly attachments: Map<string, { kind: string; data: string; chunkSize: number }>;
  private readonly deduper = new RequestDeduper();
  private readonly events = new EventLog();
  private readonly handlers = new Map<string, (params: unknown, ctx: InvokeHandlerContext) => unknown | Promise<unknown>>();
  private authenticated = false;
  private deviceId: string | null = null;

  constructor(opts: RemoteNodeOptions) {
    this.registry = opts.registry;
    this.pairing = opts.pairing;
    this.transport = opts.transport;
    this.attachments = opts.attachments ?? new Map();
  }

  handle(channel: string, handler: (params: unknown, ctx: InvokeHandlerContext) => unknown | Promise<unknown>): void {
    this.handlers.set(channel, handler);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  device(): string | null {
    return this.deviceId;
  }

  /** 引擎事件 → 追加历史 + 推给本连接（附件外置）。 */
  publishEvent(sessionId: string, event: unknown): void {
    const rec = this.events.append(sessionId, event);
    if (!this.authenticated) return;
    this.transport.send({
      t: 'push',
      channel: 'engine:event',
      payload: this.externalize(event),
      seq: rec.seq,
      sessionId,
    });
  }

  /** 状态类推送（session:status / task:status）。 */
  publish(channel: string, payload: unknown, sessionId?: string): void {
    if (!this.authenticated) return;
    this.transport.send({ t: 'push', channel, payload, seq: this.events.lastSeq(), sessionId });
  }

  /** 处理一帧（真实传输 / 测试均经此入口）。 */
  async onFrame(frame: RemoteFrame): Promise<void> {
    switch (frame.t) {
      case 'ping':
        this.transport.send({ t: 'pong' });
        return;
      case 'pair':
        this.handlePair(frame);
        return;
      case 'auth':
        this.handleAuth(frame);
        return;
      case 'invoke':
        await this.handleInvoke(frame);
        return;
      case 'attach':
        this.handleAttach(frame);
        return;
      case 'fetch':
        this.handleFetch(frame);
        return;
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private handlePair(frame: Extract<RemoteFrame, { t: 'pair' }>): void {
    const result = this.pairing.verify(frame.code);
    if (!result.ok) {
      this.pairing.recordFailure();
      this.transport.send({ t: 'pair-fail', error: result.error });
      return;
    }
    const deviceId = randomDeviceId();
    const token = randomDeviceToken();
    const permissions = DEFAULT_PERMISSIONS();
    this.registry.register({
      deviceId,
      name: frame.deviceName,
      platform: frame.platform,
      pubKey: frame.pubKey,
      tokenHash: hashToken(token),
      permissions,
      pairedAt: new Date().toISOString(),
    });
    this.transport.send({ t: 'pair-ok', deviceId, token, permissions });
  }

  private handleAuth(frame: Extract<RemoteFrame, { t: 'auth' }>): void {
    if (!this.registry.verifyToken(frame.deviceId, frame.tokenHash)) {
      this.transport.send({ t: 'auth-fail', error: 'invalid or revoked device' });
      return;
    }
    this.authenticated = true;
    this.deviceId = frame.deviceId;
    this.registry.touch(frame.deviceId);
    this.transport.send({ t: 'auth-ok', permissions: this.registry.get(frame.deviceId)?.permissions });
  }

  private async handleInvoke(frame: Extract<RemoteFrame, { t: 'invoke' }>): Promise<void> {
    if (!this.authenticated) {
      this.transport.send({ t: 'res', id: frame.id, ok: undefined as never, error: { code: 'ERR_AUTH', message: 'not authenticated' } });
      return;
    }
    const perms = this.registry.get(this.deviceId!)?.permissions ?? DEFAULT_PERMISSIONS();
    const need = CHANNEL_PERMISSION[frame.channel] ?? 'viewSessions';
    const allowed = perms[need as keyof typeof perms];
    if (need !== 'approval' && typeof allowed === 'boolean' && !allowed) {
      this.transport.send({ t: 'res', id: frame.id, ok: undefined as never, error: { code: 'ERR_FORBIDDEN', message: `device lacks ${need}` } });
      return;
    }
    if (need === 'approval') {
      const risk = (frame.params as { risk?: ApprovalRisk } | undefined)?.risk ?? 'safe';
      const action = approvalPermitted(perms, risk);
      if (action !== 'approve') {
        this.transport.send({
          t: 'res',
          id: frame.id,
          ok: undefined as never,
          error: { code: action === 'reject' ? 'ERR_FORBIDDEN' : 'ERR_DEFER', message: 'high-risk approval must be deferred to desktop' },
        });
        return;
      }
    }

    const handler = this.handlers.get(frame.channel);
    if (!handler) {
      this.transport.send({ t: 'res', id: frame.id, ok: undefined as never, error: { code: 'ERR_NO_HANDLER', message: `unknown channel ${frame.channel}` } });
      return;
    }

    const run = (): Promise<unknown> =>
      Promise.resolve(handler(frame.params, { deviceId: this.deviceId! })).catch((e) => {
        throw e;
      });

    try {
      if (frame.requestId && isIdempotentChannel(frame.channel)) {
        const dedup = this.deduper.check(frame.requestId, async () => run());
        this.transport.send({ t: 'res', id: frame.id, ok: await dedup.result });
      } else {
        this.transport.send({ t: 'res', id: frame.id, ok: await run() });
      }
    } catch (e) {
      this.transport.send({ t: 'res', id: frame.id, ok: undefined as never, error: { code: 'ERR_INVOKE', message: String((e as Error).message ?? e) } });
    }
  }

  private handleAttach(frame: Extract<RemoteFrame, { t: 'attach' }>): void {
    if (!this.authenticated) return;
    for (const rec of this.events.replaySince(frame.sessionId, frame.lastEventId)) {
      this.transport.send({ t: 'push', channel: 'engine:event', payload: this.externalize(rec.event), seq: rec.seq, sessionId: frame.sessionId });
    }
  }

  private handleFetch(frame: Extract<RemoteFrame, { t: 'fetch' }>): void {
    const store = this.attachments.get(frame.attachment);
    if (!store) {
      this.transport.send({ t: 'attachment', contentId: frame.attachment, chunk: frame.chunk, totalChunks: 0 });
      return;
    }
    const totalChunks = Math.ceil(store.data.length / store.chunkSize);
    const start = frame.chunk * store.chunkSize;
    const data = store.data.slice(start, start + store.chunkSize);
    this.transport.send({ t: 'attachment', contentId: frame.attachment, chunk: frame.chunk, totalChunks, data });
  }

  private externalize(event: unknown): unknown {
    const ev = event as { display?: unknown } | null;
    if (!ev || typeof ev !== 'object' || !('display' in ev)) return event;
    const result = externalizeAttachment(ev.display, (data, kind) => {
      const contentId = `att_${Math.random().toString(36).slice(2, 10)}`;
      this.attachments.set(contentId, { kind, data, chunkSize: 8_000 });
      return { contentId, kind, totalChunks: Math.ceil(data.length / 8_000), chunkSize: 8_000 } satisfies AttachmentRef;
    });
    return result.externalized ? { ...ev, display: result.payload } : event;
  }

  /** 节点吊销本连接设备（立即断开）。 */
  revokeCurrent(reason = 'revoked-by-user'): void {
    if (!this.deviceId) return;
    this.registry.revoke(this.deviceId);
    this.transport.send({ t: 'revoked', reason });
    this.transport.close(4001, reason);
    this.authenticated = false;
  }
}

export function DEFAULT_PERMISSIONS(): DevicePermissions {
  return {
    viewSessions: true,
    viewWorkspaceFiles: false,
    sendMessage: true,
    approveRequests: 'standard',
    triggerTasks: true,
    manageDevices: false,
    changePolicy: false,
  };
}