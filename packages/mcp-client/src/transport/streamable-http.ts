/**
 * Streamable HTTP 传输（M8 §8.3.3）+ 旧版 HTTP+SSE 降级（§8.3.4）。
 * 单端点 POST 收发；响应可为 application/json（单响应）或 text/event-stream（SSE 流）。
 * GET 端点打开服务器单向推送流；DELETE 显式终止会话。
 */
import { PROTOCOL_VERSION } from '../types.js';
import type {
  Disposable,
  HttpServerConfig,
  JsonRpcMessage,
  McpTransport,
  TransportKind,
} from './types.js';

const SESSION_HEADER = 'mcp-session-id';

/**
 * 有状态 SSE 解析器：跨 chunk 保留「未终结的事件」与「被截断的半行」。
 * 无状态的一次性 parse 会在 chunk 边界截断 data 行时丢失事件
 * （如 figma 的 initialize 响应 JSON 较大，TCP 分片后事件永远拼不完整）。
 */
class SseParser {
  private evt: { event?: string; data: string } | null = null;
  private tail = '';

  /** 喂入新解码的文本，返回本次完整就绪的事件。 */
  push(text: string): Array<{ event?: string; data: string }> {
    const events: Array<{ event?: string; data: string }> = [];
    const lines = (this.tail + text).split('\n');
    this.tail = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const line = raw.replace(/\r$/, '');
      if (i === lines.length - 1 && line !== '') {
        // 末尾无换行符 → 可能是被 chunk 边界截断的半行，留给下一个 chunk。
        this.tail = raw;
        break;
      }
      if (line === '') {
        if (this.evt) {
          events.push(this.evt);
          this.evt = null;
        }
        continue;
      }
      if (line.startsWith('event:')) {
        this.evt = this.evt ?? { data: '' };
        this.evt.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        this.evt = this.evt ?? { data: '' };
        this.evt.data += (this.evt.data ? '\n' : '') + line.slice(5).trim();
      } else if (line.startsWith(':')) {
        // 注释行，忽略。
      }
    }
    return events;
  }

  /** 流结束时的兜底：补一个换行终结符，捞回「有 data 行但缺空行」的最后一条事件。 */
  flush(): Array<{ event?: string; data: string }> {
    return this.push('\n');
  }
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
      'mcp-protocol-version': PROTOCOL_VERSION,
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
    const hadSession = Boolean(this.sessionId);
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: this.headers(auth),
      body: JSON.stringify(message),
      signal,
    });
    if (res.headers.get(SESSION_HEADER)) this.sessionId = res.headers.get(SESSION_HEADER)!;
    // 会话首次建立后（重新）打开 GET 推送流：部分服务器（如 Figma Dev Mode）会把
    // 后续请求的响应路由到 GET 会话流而非 POST 响应流（MCP 规范允许），不重开就永远收不到。
    if (this.sessionId && !hadSession) void this.openPushStream();
    // 非 2xx（202 = notification 已受理）：把状态码与响应体片段抛给上层，
    // 否则请求只会等到超时，真实原因（404/401/500）完全不可见。
    if (!res.ok && res.status !== 202) {
      const body = await res.text().catch(() => '');
      const snippet = body.trim().slice(0, 200);
      throw new Error(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      await this.consumeSse(res, signal);
    } else {
      const text = await res.text();
      for (const m of extractMessages(text)) this.dispatch(m);
    }
  }

  /** fatal=true：POST 主响应流出错时终结整个传输；push 流（GET）出错只静默降级。 */
  private async consumeSse(res: Response, signal?: AbortSignal, fatal = true): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const onEvent = (e: { event?: string; data: string }) => {
      for (const m of extractMessages(e.data)) this.dispatch(m);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
      }
      for (const e of parser.flush()) onEvent(e);
    } catch (err) {
      if (fatal && (err as Error).name !== 'AbortError') {
        this.fail(`sse error: ${(err as Error).message}`);
      }
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
      // GET 会话流的头与 POST 不同：Accept 仅 text/event-stream，且【不能】带
      // Content-Type —— Figma 等实现会对带 Content-Type 的 GET 回 409 拒绝。
      const h: Record<string, string> = {
        Accept: 'text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(this.cfg.headers ?? {}),
        ...auth,
      };
      if (this.sessionId) h[SESSION_HEADER] = this.sessionId;
      const res = await fetch(this.cfg.url, { method: 'GET', headers: h });
      if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) return;
      this.pushStream?.abort(); // 会话流重开时收掉旧流
      this.pushStream = new AbortController();
      await this.consumeSse(res, this.pushStream.signal, false);
    } catch {
      // 不支持 push 流（405 / 400 / 网络错误）→ 静默忽略，按需请求即可。
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

/**
 * 旧版 HTTP+SSE 降级传输（§8.3.4）：GET 配置 URL 建立长连 SSE 流，
 * POST 地址由服务端 `endpoint` 事件下发（如 /messages?sessionId=xxx），
 * 全部响应经 SSE 流返回。Figma Dev Mode 等服务在 streamable HTTP 不稳时
 * 依赖此传输（社区验证的备用路径）。
 */
export class HttpSseLegacyTransport implements McpTransport {
  readonly kind: TransportKind = 'http-sse-legacy';
  private msgHandlers = new Set<(msg: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private sseAbort?: AbortController;
  private started = false;
  private closed = false;
  /** 服务端 endpoint 事件下发的 POST 地址（绝对 URL）。 */
  private endpointUrl?: string;
  private endpointWaiters: Array<() => void> = [];

  constructor(private cfg: HttpServerConfig) {}

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
    // 长连 SSE 流：GET 配置的 URL 本身（旧协议不再拼接 /sse）。
    // 泵循环后台化 —— SSE 流永不结束，start() 不能阻塞在它上面（否则 connect 死锁）。
    this.sseAbort = new AbortController();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      const res = await fetch(this.cfg.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: this.sseAbort?.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(decoder.decode(value, { stream: true }))) {
          if (e.event === 'endpoint' && e.data.trim()) {
            this.endpointUrl = new URL(e.data.trim(), this.cfg.url).href;
            const waiters = this.endpointWaiters;
            this.endpointWaiters = [];
            for (const w of waiters) w();
          } else {
            for (const m of extractMessages(e.data)) this.dispatch(m);
          }
        }
      }
      for (const e of parser.flush()) for (const m of extractMessages(e.data)) this.dispatch(m);
    } catch {
      /* 连接中断 / 主动关闭 */
    }
  }

  /** POST 目标：endpoint 事件下发地址；未收到时最多等 3s，兜底同源 /messages。 */
  private async resolvePostUrl(): Promise<string> {
    if (this.endpointUrl) return this.endpointUrl;
    await Promise.race([
      new Promise<void>((r) => this.endpointWaiters.push(r)),
      new Promise<void>((r) => setTimeout(r, 3_000)),
    ]);
    return this.endpointUrl ?? new URL('/messages', this.cfg.url).href;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('legacy sse transport closed');
    const url = await this.resolvePostUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok && res.status !== 202) {
      const body = await res.text().catch(() => '');
      const snippet = body.trim().slice(0, 200);
      throw new Error(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    // 响应统一走 GET 流；POST 响应体按约定为空，仍尽力解析。
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
