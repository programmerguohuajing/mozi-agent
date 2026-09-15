import type { ToolResult } from '@mozi/shared';
/**
 * MCP 桥接层（M8 §8.5–8.7）：把多个 server 连接聚合进 mozi 的工具/命令/资源体系。
 * - 工具：McpToolAdapter 注册进 ToolRegistry（前缀隔离防重名）
 * - 资源：内置 mcp_read_resource 工具 + 可选订阅注入
 * - Prompts：映射为 /mcp:<server>:<prompt> 命令描述（由 CLI/桌面注册）
 */
import type { AgentTool, JSONSchema, ToolContext } from '@mozi/tools';
import type { ToolRegistry } from '@mozi/tools';
import { type ConnectionDeps, McpServerConnection } from './connection.js';
import {
  MemoryTokenStore,
  type OAuthCallbacks,
  OAuthFlow,
  type TokenStore,
  discoverAuthServer,
} from './oauth.js';
import { McpToolAdapter } from './tools.js';
import { StdioTransport } from './transport/stdio.js';
import { StreamableHttpTransport } from './transport/streamable-http.js';
import type { McpServerConfig } from './transport/types.js';
import type { McpServerOptions, McpToolDef, PromptGetResult } from './types.js';

export interface McpServerEntry {
  config: McpServerConfig;
  options?: McpServerOptions;
}

export interface PromptCommand {
  serverId: string;
  promptName: string;
  /** 斜杠命令：/mcp:<serverId>:<promptName> */
  command: string;
  description: string;
  arguments: Array<{ name: string; required?: boolean; description?: string }>;
}

export interface McpBridgeDeps extends ConnectionDeps {
  registry: ToolRegistry;
  tokenStore?: TokenStore;
  oauthCallbacks?: OAuthCallbacks;
}

export class McpBridge {
  private connections = new Map<string, McpServerConnection>();
  private toolsByServer = new Map<string, Map<string, McpToolAdapter>>();
  private promptsByServer = new Map<string, PromptCommand[]>();
  private readResourceTool?: ReadResourceTool;

  constructor(
    private servers: McpServerEntry[],
    private deps: McpBridgeDeps,
  ) {}

  async connectAll(): Promise<void> {
    // 顺序连接以避免一次性过多子进程；单 server 失败不影响其他（错误隔离，§8.14）。
    for (const entry of this.servers) {
      try {
        await this.connectOne(entry);
      } catch (err) {
        this.deps.emit?.({
          type: 'internal.debug',
          message: `mcp connect failed: ${entry.config.id}: ${(err as Error).message}`,
          ts: new Date().toISOString(),
        });
      }
    }
    // 注册内置资源读取工具（一次）。
    this.readResourceTool = new ReadResourceTool(this);
    this.deps.registry.register(this.readResourceTool);
  }

  private async connectOne(entry: McpServerEntry): Promise<void> {
    const transport = this.makeTransport(entry);
    const conn = new McpServerConnection(entry.config.id, transport, entry.options ?? {}, {
      ...this.deps,
      onToolsChanged: (tools) => this.registerTools(entry.config.id, tools),
    });
    this.connections.set(entry.config.id, conn);
    await conn.connect();
    const tools = await conn.listTools();
    this.registerTools(entry.config.id, tools);
    if (conn.capabilities.prompts?.listChanged !== false) {
      const prompts = await conn.listPrompts();
      this.promptsByServer.set(
        entry.config.id,
        prompts.map((p) => ({
          serverId: entry.config.id,
          promptName: p.name,
          command: `/mcp:${entry.config.id}:${p.name}`,
          description: p.description ?? p.title ?? `MCP prompt ${p.name}`,
          arguments: (p.arguments ?? []).map((a) => ({
            name: a.name,
            required: a.required,
            description: a.description,
          })),
        })),
      );
    }
  }

  private makeTransport(entry: McpServerEntry) {
    const cfg = entry.config;
    if (cfg.kind === 'stdio') {
      const env = cfg.env
        ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, resolveEnvVar(v)]))
        : undefined;
      return new StdioTransport({ ...cfg, env });
    }
    // http：OAuth 时提供懒加载 token 供应器。
    if (cfg.auth?.mode === 'oauth') {
      const store = this.deps.tokenStore ?? new MemoryTokenStore();
      let flow: OAuthFlow | undefined;
      const getToken = async (): Promise<string | undefined> => {
        const authServer = await discoverAuthServer(cfg.url);
        if (!authServer) return undefined;
        flow ??= new OAuthFlow(cfg.id, authServer, 'http://127.0.0.1:0/callback', store, {
          openBrowser: (url) =>
            this.deps.oauthCallbacks?.openBrowser(url) ?? Promise.reject(new Error('no browser')),
          promptCode: this.deps.oauthCallbacks?.promptCode,
        });
        return flow.authorize(cfg.url);
      };
      return new StreamableHttpTransport(cfg, { getToken });
    }
    return new StreamableHttpTransport(cfg);
  }

  private registerTools(serverId: string, defs: McpToolDef[]): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    const map = this.toolsByServer.get(serverId) ?? new Map<string, McpToolAdapter>();
    // 先移除旧的（list_changed 热更新）。
    for (const [name, adapter] of map) {
      this.deps.registry.unregister(name);
      map.delete(name);
    }
    for (const def of defs) {
      const adapter = new McpToolAdapter(conn, def);
      map.set(adapter.name, adapter);
      this.deps.registry.register(adapter);
    }
    this.toolsByServer.set(serverId, map);
  }

  /** 当前所有 MCP 工具（供引擎 schema 导出）。 */
  tools(): AgentTool[] {
    const out: AgentTool[] = [];
    for (const m of this.toolsByServer.values()) for (const a of m.values()) out.push(a);
    return out;
  }

  promptCommands(): PromptCommand[] {
    const out: PromptCommand[] = [];
    for (const list of this.promptsByServer.values()) out.push(...list);
    return out;
  }

  /** 取 prompt 内容（messages 注入引擎 user 侧，见 §8.7）。 */
  async getPromptMessages(
    serverId: string,
    promptName: string,
    args: Record<string, string>,
  ): Promise<PromptGetResult | undefined> {
    const conn = this.connections.get(serverId);
    if (!conn) return undefined;
    return conn.getPrompt(promptName, args);
  }

  async readResource(serverId: string, uri: string) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`unknown mcp server: ${serverId}`);
    return conn.readResource(uri);
  }

  async closeAll(): Promise<void> {
    if (this.readResourceTool) this.deps.registry.unregister(this.readResourceTool.name);
    await Promise.all([...this.connections.values()].map((c) => c.close().catch(() => {})));
    this.connections.clear();
    this.toolsByServer.clear();
  }
}

/** 解析 `$VAR` 形式的环境变量引用（§8.12）。 */
function resolveEnvVar(value: string): string {
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

/** 内置工具：mcp_read_resource（§8.6 ① 显式读取）。 */
class ReadResourceTool implements AgentTool {
  readonly name = 'mcp_read_resource';
  readonly version = '1.0.0';
  readonly description = '读取指定 MCP server 暴露的资源（uri）。参数：server, uri。';
  readonly riskLevel = 'read' as const;
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server id' },
      uri: { type: 'string', description: '资源 uri' },
    },
    required: ['server', 'uri'],
  };

  constructor(private bridge: McpBridge) {}

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const server = String(input.server ?? '');
    const uri = String(input.uri ?? '');
    try {
      const contents = await this.bridge.readResource(server, uri);
      const text = contents
        .map((c) => c.text ?? (c.blob ? `<binary ${c.mimeType ?? ''}>` : ''))
        .join('\n')
        .slice(0, 20000);
      return { callId: '', content: text, isError: false };
    } catch (err) {
      return {
        callId: '',
        content: `read resource failed: ${(err as Error).message}`,
        isError: true,
        meta: { errorKind: 'mcp_resource_failed' },
      };
    }
  }
}
