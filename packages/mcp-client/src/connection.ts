/**
 * MCP server 连接（M8 §8.4）：初始化握手、能力协商、心跳、状态机、反向请求/通知路由。
 * 单个连接对应一个 server；McpRegistry 管理多个连接。
 */
import type { AgentEvent } from '@mozi/shared';
import { JsonRpcClient } from './jsonrpc.js';
import type { McpTransport } from './transport/types.js';
import {
  type InitializeResult,
  type McpPromptDef,
  type McpResourceDef,
  type McpServerOptions,
  type McpToolDef,
  PROTOCOL_VERSION,
  type PromptGetResult,
  type ResourceContent,
  type SamplingContext,
  type ServerCapabilities,
  type ServerStatus,
  type ToolCallResult,
} from './types.js';

export type ElicitHandler = (info: {
  serverId: string;
  requestId: string;
  message: string;
  schema: Record<string, unknown>;
}) => Promise<{ decision: 'submit' | 'cancel'; values?: Record<string, unknown> }>;

export type RootsProvider = () => Array<{ uri: string; name: string }>;

export interface ConnectionDeps {
  /** 状态变化事件（mcp.server.status，见 §8.15）。 */
  emit?: (event: AgentEvent) => void;
  sampling?: SamplingContext;
  elicit?: ElicitHandler;
  roots?: RootsProvider;
  onToolsChanged?: (tools: McpToolDef[]) => void;
  onResourceUpdated?: (uri: string) => void;
  onProgress?: (token: unknown, progress: number, total?: number, message?: string) => void;
  onLog?: (level: string, logger: string | undefined, data: unknown) => void;
  onCancelled?: (requestId: string) => void;
}

const PING_INTERVAL_MS = 30_000;
const PING_FAIL_LIMIT = 2;

export class McpServerConnection {
  readonly serverId: string;
  status: ServerStatus = 'disconnected';
  capabilities: ServerCapabilities = {};
  serverInfo?: { name: string; version?: string };
  private rpc?: JsonRpcClient;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingFails = 0;
  private pingSeq = 1;
  private transport: McpTransport;
  private opts: McpServerOptions;
  private deps: ConnectionDeps;
  private rpcResolved = false;

  constructor(
    serverId: string,
    transport: McpTransport,
    opts: McpServerOptions,
    deps: ConnectionDeps,
  ) {
    this.serverId = serverId;
    this.transport = transport;
    this.opts = opts;
    this.deps = deps;
  }

  private setStatus(s: ServerStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    this.deps.emit?.({
      type: 'mcp.server.status',
      serverId: this.serverId,
      status: s,
      detail,
      ts: new Date().toISOString(),
    });
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    await this.transport.start();
    const rpc = new JsonRpcClient(this.transport);
    this.rpc = rpc;
    this.rpcResolved = true;
    this.wireHandlers(rpc);

    const result = (await rpc.request<InitializeResult>(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          sampling: {},
          roots: { listChanged: false },
          elicitation: {},
        },
        clientInfo: { name: 'mozi', version: '2.x' },
      },
      { timeoutMs: 30_000 },
    )) as InitializeResult;
    this.capabilities = result.capabilities ?? {};
    this.serverInfo = result.serverInfo;
    await rpc.notify('notifications/initialized');
    this.setStatus('connected');
    this.startPing();
  }

  private wireHandlers(rpc: JsonRpcClient): void {
    rpc.onReverseRequest((method, params) => this.onReverseRequest(method, params));
    rpc.onNotification((method, params) => this.onNotification(method, params));
  }

  private async onReverseRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'sampling/createMessage':
        return this.handleSampling(params);
      case 'elicitation/create':
        return this.handleElicit(params);
      case 'roots/list':
        return { roots: this.deps.roots?.() ?? [] };
      case 'ping':
        return {};
      default:
        // 未知反向请求：返回空结果，避免协议挂起。
        return {};
    }
  }

  private async handleSampling(params: unknown): Promise<unknown> {
    const ctx = this.deps.sampling;
    const p = params as {
      messages: unknown[];
      maxTokens?: number;
      modelPreferences?: unknown;
    };
    if (!ctx || !ctx.enabled || this.opts.sampling === 'deny') {
      throw new Error('sampling denied by policy');
    }
    if (!ctx.allowServers.includes(this.serverId)) {
      // 非白名单 server：需审批。
      const decision = await ctx.requestApproval({
        serverId: this.serverId,
        requestId: `smp_${Date.now()}`,
        promptPreview: JSON.stringify(p.messages).slice(0, 200),
        maxTokens: p.maxTokens ?? 0,
      });
      if (decision !== 'allow') throw new Error('sampling denied by user');
    }
    const maxTokens = Math.min(p.maxTokens ?? 1024, ctx.maxTokens);
    const out = await ctx.runChat(p.messages, maxTokens);
    return {
      role: 'assistant',
      content: [{ type: 'text', text: out.text }],
      model: 'mozi-executor',
      stopReason: 'endTurn',
    };
  }

  private async handleElicit(params: unknown): Promise<unknown> {
    const h = this.deps.elicit;
    const p = params as { message: string; requestedSchema: Record<string, unknown> };
    if (!h) throw new Error('elicitation not supported');
    const res = await h({
      serverId: this.serverId,
      requestId: `elc_${Date.now()}`,
      message: p.message,
      schema: p.requestedSchema,
    });
    if (res.decision === 'cancel') throw new Error('elicitation cancelled');
    return { content: res.values ?? {} };
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'notifications/tools/list_changed') {
      void this.listTools().then((t) => this.deps.onToolsChanged?.(t));
    } else if (method === 'notifications/resources/updated') {
      const uri = (params as { uri?: string }).uri;
      if (uri) this.deps.onResourceUpdated?.(uri);
    } else if (method === 'notifications/progress') {
      const p = params as {
        progressToken: unknown;
        progress: number;
        total?: number;
        message?: string;
      };
      this.deps.onProgress?.(p.progressToken, p.progress, p.total, p.message);
    } else if (method === 'notifications/message') {
      const p = params as { level: string; logger?: string; data: unknown };
      this.deps.onLog?.(p.level, p.logger, p.data);
    } else if (method === 'notifications/cancelled') {
      const id = (params as { requestId?: string }).requestId;
      if (id) this.deps.onCancelled?.(id);
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      void this.ping().catch(() => {
        this.pingFails++;
        if (this.pingFails >= PING_FAIL_LIMIT) {
          this.setStatus('degraded', 'ping failed');
        }
      });
    }, PING_INTERVAL_MS);
  }

  private async ping(): Promise<void> {
    if (!this.rpc) return;
    await this.rpc.request('ping', undefined, { timeoutMs: 5000, signal: undefined as never });
    this.pingFails = 0;
    if (this.status === 'degraded') this.setStatus('connected');
    void this.pingSeq++;
  }

  // ---- 能力调用 API（供 registry / 适配器使用）----

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.requireRpc().request<{ tools: McpToolDef[] }>(
      'tools/list',
      undefined,
      // 连接/热更新路径不允许无限等待：服务器不给响应时按超时失败，状态如实变 offline。
      { timeoutMs: 30_000 },
    )) as {
      tools: McpToolDef[];
    };
    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number; progressToken?: string } = {},
  ): Promise<ToolCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (opts.progressToken) {
      params._meta = { progressToken: opts.progressToken };
    }
    return (await this.requireRpc().request<ToolCallResult>('tools/call', params, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    })) as ToolCallResult;
  }

  async listResources(): Promise<McpResourceDef[]> {
    const res = (await this.requireRpc().request<{ resources: McpResourceDef[] }>(
      'resources/list',
    )) as {
      resources: McpResourceDef[];
    };
    return res.resources ?? [];
  }

  async readResource(uri: string): Promise<ResourceContent[]> {
    const res = (await this.requireRpc().request<{ contents: ResourceContent[] }>(
      'resources/read',
      {
        uri,
      },
    )) as { contents: ResourceContent[] };
    return res.contents ?? [];
  }

  async subscribeResource(uri: string): Promise<void> {
    if (this.capabilities.resources?.subscribe) {
      await this.requireRpc().notify('resources/subscribe', { uri });
    }
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    const res = (await this.requireRpc().request<{ prompts: McpPromptDef[] }>(
      'prompts/list',
      undefined,
      { timeoutMs: 30_000 },
    )) as {
      prompts: McpPromptDef[];
    };
    return res.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<PromptGetResult> {
    return (await this.requireRpc().request<PromptGetResult>('prompts/get', {
      name,
      arguments: args,
    })) as PromptGetResult;
  }

  async cancel(requestId: string): Promise<void> {
    await this.requireRpc().notify('notifications/cancelled', { requestId });
  }

  private requireRpc(): JsonRpcClient {
    if (!this.rpc || !this.rpcResolved) throw new Error('connection not established');
    return this.rpc;
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      await this.transport.close();
    } catch {
      /* ignore */
    }
    this.setStatus('offline');
  }
}
