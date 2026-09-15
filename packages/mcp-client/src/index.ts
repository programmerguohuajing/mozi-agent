/**
 * @mozi/mcp-client —— 完整 MCP 客户端（M8 §8）。
 * 对外暴露：桥接层 McpBridge、传输实现、JSON-RPC 客户端、OAuth 流程、协议类型。
 */
export const PKG = '@mozi/mcp-client';

export {
  McpBridge,
  type McpBridgeDeps,
  type McpServerEntry,
  type PromptCommand,
} from './bridge.js';
export {
  McpServerConnection,
  type ConnectionDeps,
  type ElicitHandler,
  type RootsProvider,
} from './connection.js';
export { JsonRpcClient, type ReverseRequestHandler, type NotificationHandler } from './jsonrpc.js';
export { McpToolAdapter } from './tools.js';
export { StdioTransport } from './transport/stdio.js';
export {
  StreamableHttpTransport,
  HttpSseLegacyTransport,
} from './transport/streamable-http.js';
export { InMemoryTransport } from './transport/mock.js';
export type {
  McpTransport,
  Disposable,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  TransportKind,
  StdioServerConfig,
  HttpServerConfig,
  McpServerConfig,
} from './transport/types.js';
export {
  OAuthFlow,
  MemoryTokenStore,
  genPkce,
  discoverAuthServer,
  type TokenStore,
  type TokenSet,
  type OAuthCallbacks,
} from './oauth.js';
export {
  PROTOCOL_VERSION,
  type InitializeResult,
  type ServerCapabilities,
  type McpToolDef,
  type McpResourceDef,
  type McpPromptDef,
  type McpServerOptions,
  type ContentBlock,
  type ToolCallResult,
  type ResourceContent,
  type PromptGetResult,
  type ServerStatus,
  type SamplingContext,
} from './types.js';
