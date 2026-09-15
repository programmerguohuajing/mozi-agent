/**
 * MCP 传输层抽象（M8 §8.3）。
 * 统一 stdio / Streamable HTTP / 旧版 HTTP+SSE 三种传输，对上层 JsonRpc 客户端透明。
 */

/** 可释放资源句柄（onMessage/onClose 注册时返回）。 */
export interface Disposable {
  dispose(): void;
}

/** JSON-RPC 2.0 基础消息形态。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type TransportKind = 'stdio' | 'streamable-http' | 'http-sse-legacy';

/** stdio 本地子进程 server 配置。 */
export interface StdioServerConfig {
  kind: 'stdio';
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 握手超时，默认 5000ms。 */
  timeoutMs?: number;
  /** 惰性 spawn：注册 stub，首次调用才启动（默认 false，即连即 spawn）。 */
  lazy?: boolean;
}

/** 远程 Streamable HTTP / 旧版 SSE server 配置。kind='http-sse-legacy' 走旧版 HTTP+SSE 协议。 */
export interface HttpServerConfig {
  kind: 'http' | 'http-sse-legacy';
  id: string;
  url: string;
  auth?: { mode: 'none' | 'bearer' | 'oauth'; bearerEnv?: string };
  headers?: Record<string, string>;
  timeoutMs?: number;
  reconnect?: { maxRetries: number; backoffMs: number };
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * 传输层契约：上层只认 send / onMessage / onClose / start / close。
 * send 发送后，对应响应经 onMessage 异步回调到达（JSON-RPC 关联由 JsonRpc 层负责）。
 */
export interface McpTransport {
  readonly kind: TransportKind;
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable;
  onClose(handler: (reason: string) => void): Disposable;
  /** spawn / 建连 / 握手前准备。 */
  start(): Promise<void>;
  /** 优雅终止（SIGTERM → 1s → SIGKILL / 关 HTTP 连接）。 */
  close(): Promise<void>;
}
