/**
 * Streamable HTTP 传输（M8 §8.3.3）+ 旧版 HTTP+SSE 降级（§8.3.4）。
 * 单端点 POST 收发；响应可为 application/json（单响应）或 text/event-stream（SSE 流）。
 * GET 端点打开服务器单向推送流；DELETE 显式终止会话。
 */
import type {
  Disposable,
  HttpServerConfig,
  JsonRpcMessage,
  McpTransport,
  TransportKind,
} from './types.js';

const SESSION_HEADER = 'mcp-session-id';

/** 解析一段 SSE 文本为事件对象数组（data: 多行合并）。 */
function parseSse(chunk: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  let buf = chunk;
  let evt: { event?: string; data: string } | null = null;
  for (const rawLine of buf.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      if (evt) {
        events.push(evt);
        evt = null;
      }
      continue;
    }
    if (line.startsWith('event:')) {
      evt = evt ?? { data: '' };
      evt.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      evt = evt ?? { data: '' };
      evt.data += (evt.data ? '\n' : '') + line.slice(5).trim();
    } else if (line.startsWith(':')) {
      // 注释行，忽略。
    }
  }
  return events;
}

/** 从 SSE data 文本中提取 JSON-RPC 消息（忽略非 JSON 的注释/keepalive）。 */
function extractMessages(data: string): JsonRpcMessage[] {
  const msgs: JsonRpcMessage[] = [];
  for (const part of data.split('\n')) {
    const t = part.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && obj.jsonrpc === '2.0') msgs.push(obj as JsonRpcMessage);
    } catch {
      /* keepalive / comment */
    }
  }
  return msgs;
}

export class StreamableHttpTransport implements McpTransport {
  readonly kind: TransportKind = 'streamable-http';
  private msgHandlers = new Set<(msg: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private sessionId?: string;
  private pushStream?: AbortController;
  private started = false;
  private closed = false;
  private readonly timeoutMs: number;
  private getToken?: () => Promise<string | undefined>;

  constructor(
    private cfg: HttpServerConfig,
    opts: { getToken?: () => Promise<string | undefined> } = {},
  ) {
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.getToken = opts.getToken;
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable {
    this.msgHandlers.add(handler);
    return { dispose: () => this.msgHandlers.delete(handler) };
  }

  onClose(handler: (reason: string) => void): Disposable {
    this.closeHandlers.add(handler);
    return { dispose: () => this.closeHandlers.delete(handler) };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 打开服务器单向推送流（GET）。若返回 405 表示不支持，静默忽略。
    void this.openPushStream();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
      ...extra,
    };
    if (this.sessionId) h[SESSION_HEADER] = this.sessionId;
    return h;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.cfg.auth?.mode === 'bearer' && this.cfg.auth.bearerEnv) {
      const tok = process.env[this.cfg.auth.bearerEnv];
      if (tok) return { Authorization: `Bearer ${tok}` };
    }
    if (this.cfg.auth?.mode === 'oauth' && this.getToken) {
      const tok = await this.getToken();
      if (tok) return { Authorization: `Bearer ${tok}` };
    }
    return {};
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('http transport closed');
    const auth = await this.authHeaders();
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: this.headers(auth),
      body: JSON.stringify(message),
      signal,
    });
    if (res.headers.get(SESSION_HEADER)) this.sessionId = res.headers.get(SESSION_HEADER)!;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      await this.consumeSse(res, signal);
    } else {
      const text = await res.text();
      for (const m of extractMessages(text)) this.dispatch(m);
    }
  }

  private async consumeSse(res: Response, signal?: AbortSignal): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = parseSse(buf);
        buf = '';
        for (const e of events) for (const m of extractMessages(e.data)) this.dispatch(m);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.fail(`sse error: ${(err as Error).message}`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private async openPushStream(): Promise<void> {
    if (this.closed) return;
    try {
      const auth = await this.authHeaders();
      const res = await fetch(this.cfg.url, { method: 'GET', headers: this.headers(auth) });
      if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) return;
      this.pushStream = new AbortController();
      await this.consumeSse(res, this.pushStream.signal);
    } catch {
      // 不支持 push 流（405 / 网络错误）→ 静默忽略，按需请求即可。
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    for (const h of this.msgHandlers) h(msg);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h(reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pushStream?.abort();
    if (this.sessionId) {
      try {
        await fetch(this.cfg.url, {
          method: 'DELETE',
          headers: this.headers(),
        });
      } catch {
        /* ignore */
      }
    }
    for (const h of this.closeHandlers) h('closed');
  }
}

/** 旧版 HTTP+SSE 降级传输（§8.3.4）：POST /messages + GET /sse 双端点。 */
export class HttpSseLegacyTransport implements McpTransport {
  readonly kind: TransportKind = 'http-sse-legacy';
  private msgHandlers = new Set<(msg: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private sseAbort?: AbortController;
  private started = false;
  private closed = false;
  private readonly baseUrl: string;

  constructor(private cfg: HttpServerConfig) {
    this.baseUrl = cfg.url.replace(/\/$/, '');
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable {
    this.msgHandlers.add(handler);
    return { dispose: () => this.msgHandlers.delete(handler) };
  }
  onClose(handler: (reason: string) => void): Disposable {
    this.closeHandlers.add(handler);
    return { dispose: () => this.closeHandlers.delete(handler) };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 打开 SSE 推送流（GET /sse）。
    this.sseAbort = new AbortController();
    try {
      const res = await fetch(`${this.baseUrl}/sse`, { method: 'GET', signal: this.sseAbort.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = parseSse(buf);
        buf = '';
        for (const e of events) for (const m of extractMessages(e.data)) this.dispatch(m);
      }
    } catch {
      /* ignore */
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    for (const m of extractMessages(text)) this.dispatch(m);
  }

  private dispatch(msg: JsonRpcMessage): void {
    for (const h of this.msgHandlers) h(msg);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sseAbort?.abort();
    for (const h of this.closeHandlers) h('closed');
  }
}
