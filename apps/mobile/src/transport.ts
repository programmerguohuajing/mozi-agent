/**
 * WSS 传输适配器 + MobileRemoteClient 实现（M4.75 / M14 §14.8）。
 *
 * 传输层：Node 全局 WebSocket（Expo web/RN 18+ 均内置）。
 * 语义：与 @mozi/protocol RemoteFrame/RemotePush 同构——
 *   connect: wss://node → pair → auth → (服务端 push 事件经 onPush 订阅)
 *   invoke:  request/response 按 id 配对；requestId 幂等由服务端去重。
 *   attach:  断线重连时发送 lastEventId，服务端重放历史。
 */
import type { RemoteFrame, RemotePush } from '@mozi/protocol';
import type { RemoteClient, ClientConnState } from './client';

export class WssTransport {
  private ws: WebSocket | null = null;
  private pushHandlers = new Set<(frame: RemotePush) => void>();
  private stateHandlers = new Set<(s: ClientConnState) => void>();
  private state: ClientConnState = 'disconnected';

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        this.setState('disconnected');
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws.onopen = () => {
        this.setState('connected');
        resolve();
      };
      this.ws.onerror = (e) => {
        if (this.state === 'connecting') reject(new Error('WSS connection failed'));
        void e;
      };
      this.ws.onclose = () => {
        this.setState('disconnected');
      };
      this.ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as RemotePush;
          this.pushHandlers.forEach((cb) => cb(frame));
        } catch {
          /* 非 JSON 帧：忽略 */
        }
      };
    });
  }

  send(frame: RemoteFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('WSS not connected');
    this.ws.send(JSON.stringify(frame));
  }

  onPush(cb: (frame: RemotePush) => void): () => void {
    this.pushHandlers.add(cb);
    return () => this.pushHandlers.delete(cb);
  }

  onState(cb: (s: ClientConnState) => void): () => void {
    this.stateHandlers.add(cb);
    cb(this.state);
    return () => this.stateHandlers.delete(cb);
  }

  private setState(s: ClientConnState): void {
    this.state = s;
    this.stateHandlers.forEach((cb) => cb(s));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }
}

/** 等待下一个满足谓词的推送帧（带超时）。 */
export function waitForPush<T extends RemotePush>(
  transport: WssTransport,
  pred: (f: RemotePush) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`push timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    const off = transport.onPush((f) => {
      if (pred(f)) {
        clearTimeout(timer);
        off();
        resolve(f as T);
      }
    });
  });
}

/** MobileRemoteClient：配对 → 认证 → invoke / attach 全链路（§14.8 RemoteClient 契约实现）。 */
export class MobileRemoteClient implements RemoteClient {
  private connState: ClientConnState = 'disconnected';
  private deviceId: string | null = null;
  private token: string | null = null;
  private permissions: unknown = null;
  private invokeSeq = 0;
  private pushCb: ((frame: RemotePush) => void) | null = null;

  constructor(
    private readonly transport: WssTransport,
    private readonly deviceInfo: { deviceName: string; platform: string; pubKey: string },
  ) {
    transport.onPush((f) => this.pushCb?.(f));
    transport.onState((s) => {
      this.connState = s;
    });
  }

  state(): ClientConnState {
    return this.connState;
  }

  currentDevice(): { deviceId: string; token: string } | null {
    return this.deviceId && this.token ? { deviceId: this.deviceId, token: this.token } : null;
  }

  currentPermissions(): unknown {
    return this.permissions;
  }

  async connect(opts: { pairingCode: string }): Promise<void> {
    await this.transport.connect();
    this.transport.send({
      t: 'pair',
      code: opts.pairingCode,
      deviceName: this.deviceInfo.deviceName,
      platform: this.deviceInfo.platform,
      pubKey: this.deviceInfo.pubKey,
    });
    const pair = await waitForPush<Extract<RemotePush, { t: 'pair-ok' | 'pair-fail' }>>(
      this.transport,
      (f) => f.t === 'pair-ok' || f.t === 'pair-fail',
    );
    if (pair.t !== 'pair-ok') throw new Error(`配对失败: ${pair.error}`);
    this.deviceId = pair.deviceId;
    this.token = pair.token;
    this.permissions = pair.permissions;
  }

  async auth(deviceId: string, token: string): Promise<void> {
    this.transport.send({ t: 'auth', deviceId, tokenHash: await sha256Hex(token) });
    const res = await waitForPush<Extract<RemotePush, { t: 'auth-ok' | 'auth-fail' }>>(
      this.transport,
      (f) => f.t === 'auth-ok' || f.t === 'auth-fail',
    );
    if (res.t !== 'auth-ok') throw new Error(`认证失败: ${res.error}`);
    this.permissions = res.permissions ?? this.permissions;
  }

  async invoke<T = unknown>(channel: string, params: unknown, requestId?: string): Promise<T> {
    const id = `inv-${++this.invokeSeq}`;
    this.transport.send({ t: 'invoke', id, channel, params, ...(requestId ? { requestId } : {}) });
    const res = await waitForPush<Extract<RemotePush, { t: 'res' }>>(
      this.transport,
      (f) => f.t === 'res' && f.id === id,
    );
    if ('error' in res && res.error) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.ok as T;
  }

  onPush(cb: (frame: RemotePush) => void): () => void {
    this.pushCb = cb;
    return () => {
      this.pushCb = null;
    };
  }

  async attach(sessionId: string, lastEventId?: number): Promise<void> {
    this.transport.send({ t: 'attach', sessionId, ...(lastEventId != null ? { lastEventId } : {}) });
  }

  close(): void {
    this.transport.close();
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}