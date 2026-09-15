/**
 * JSON-RPC 2.0 客户端（M8）：请求/响应关联、通知分发、server→client 反向请求路由。
 * 与传输层解耦——只依赖 McpTransport.send / onMessage。
 */
import type {
  Disposable,
  JsonRpcMessage,
  JsonRpcRequest,
  McpTransport,
} from './transport/types.js';

/** server→client 反向请求处理（如 sampling/createMessage、elicitation/create、roots/list、ping）。 */
export type ReverseRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

/** server→client 通知处理（如 notifications/tools/list_changed、progress、logging/message）。 */
export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private reverseHandlers: ReverseRequestHandler[] = [];
  private notifHandlers: NotificationHandler[] = [];
  private msgDisp: Disposable;
  private closeDisp: Disposable;
  private closed = false;

  constructor(private transport: McpTransport) {
    this.msgDisp = transport.onMessage((m) => this.onMessage(m));
    this.closeDisp = transport.onClose(() => this.onClose());
  }

  onReverseRequest(handler: ReverseRequestHandler): Disposable {
    this.reverseHandlers.push(handler);
    return {
      dispose: () => {
        const i = this.reverseHandlers.indexOf(handler);
        if (i >= 0) this.reverseHandlers.splice(i, 1);
      },
    };
  }

  onNotification(handler: NotificationHandler): Disposable {
    this.notifHandlers.push(handler);
    return {
      dispose: () => {
        const i = this.notifHandlers.indexOf(handler);
        if (i >= 0) this.notifHandlers.splice(i, 1);
      },
    };
  }

  /** 发起请求，返回 result；超时或失败抛错。 */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    let rejectPending!: (err: Error) => void;
    const p = new Promise<T>((resolve, reject) => {
      rejectPending = reject;
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(
          () => reject(new Error(`mcp request timeout: ${method}`)),
          opts.timeoutMs,
        );
      }
      this.pending.set(id, pending);
      if (opts.signal) {
        if (opts.signal.aborted) {
          this.clearPending(id);
          reject(new Error('aborted'));
          return;
        }
        opts.signal.addEventListener(
          'abort',
          () => {
            this.clearPending(id);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }
    });
    // 不 await send：Streamable HTTP 下服务器可能对 POST 回以 SSE 流且不主动关流
    // （响应消息在流中先行到达），阻塞 send 会把 request 拖到超时。send 失败时
    // 立即 reject 对应 pending（顺带修复原实现在 send 抛错后 pending 泄漏的问题）。
    void this.transport.send(req, opts.signal).catch((err: unknown) => {
      this.clearPending(id);
      rejectPending(err instanceof Error ? err : new Error(String(err)));
    });
    return p;
  }

  /** 发送通知（无响应等待）。通知是 fire-and-forget：不阻塞在 send 上
   *  （服务器可能对 notification POST 回以不关流的 SSE），投递失败也不影响主流程。 */
  async notify(method: string, params?: unknown): Promise<void> {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    void this.transport.send(msg).catch(() => {
      /* 通知投递失败不阻塞调用方 */
    });
  }

  private clearPending(id: number | string): void {
    const p = this.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private onMessage(msg: JsonRpcMessage): void {
    // 响应（含 result/error 且带 id）
    if (
      ('id' in msg && (msg as { result?: unknown }).result !== undefined) ||
      (msg as { error?: unknown }).error
    ) {
      const id = (msg as { id: number | string }).id;
      const p = this.pending.get(id);
      if (!p) return;
      this.clearPending(id);
      const err = (msg as { error?: { code: number; message: string } }).error;
      if (err) p.reject(new Error(`[${err.code}] ${err.message}`));
      else p.resolve((msg as { result: unknown }).result);
      return;
    }
    // 反向请求（带 method + id，无 result/error）
    if (
      'method' in msg &&
      'id' in msg &&
      !(msg as { result?: unknown }).result &&
      !(msg as { error?: unknown }).error
    ) {
      const { method, params, id } = msg as {
        method: string;
        params: unknown;
        id: number | string;
      };
      void this.handleReverse(method, params, id);
      return;
    }
    // 通知（带 method，无 id）
    if ('method' in msg && !('id' in msg)) {
      const m = msg as { method: string; params: unknown };
      for (const h of this.notifHandlers) h(m.method, m.params);
    }
  }

  private async handleReverse(method: string, params: unknown, id: number | string): Promise<void> {
    try {
      let result: unknown = {};
      for (const h of this.reverseHandlers) {
        const r = await h(method, params);
        if (r !== undefined) result = r;
      }
      await this.transport.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      await this.transport.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const e = new Error('transport closed');
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  dispose(): void {
    this.msgDisp.dispose();
    this.closeDisp.dispose();
  }
}
