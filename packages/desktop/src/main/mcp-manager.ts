/**
 * MCP 管理中心（M10 §10.5⑦）。
 *
 * 主进程单例持有 MCP server 配置与状态；多会话共享连接（§8.13 桌面端）。
 * 本类只做「配置 + 状态 + 生命周期编排」，真正的连接由 `@mozi/mcp-client` 的
 * McpBridge 承担（经注入的 `connect` / `disconnect` 回调解耦，便于测试）。
 */
import type { McpAddRequest, McpServerInfo } from '@mozi/protocol';

export interface McpManagerDeps {
  /** 连接（或重连）一个 server，返回工具数。 */
  connect: (spec: McpAddRequest) => Promise<{ toolCount: number }>;
  /** 断开一个 server。 */
  disconnect: (id: string) => Promise<void>;
  /** 持久化 server 配置。 */
  persist: (servers: McpAddRequest[]) => void;
  /** 初始配置。 */
  initial?: McpAddRequest[];
}

export class McpManager {
  private readonly servers = new Map<string, { spec: McpAddRequest; info: McpServerInfo }>();

  constructor(private readonly deps: McpManagerDeps) {
    for (const spec of deps.initial ?? []) {
      this.servers.set(spec.id, {
        spec,
        info: {
          id: spec.id,
          transport: spec.transport,
          status: 'disconnected',
          toolCount: 0,
          sampling: 'ask',
          trusted: false,
        },
      });
    }
  }

  list(): McpServerInfo[] {
    return [...this.servers.values()].map((s) => s.info);
  }

  async add(req: McpAddRequest): Promise<{ ok: boolean; error?: string }> {
    if (this.servers.has(req.id)) {
      return { ok: false, error: `server id 已存在: ${req.id}` };
    }
    if (req.transport === 'stdio' && !req.command) {
      return { ok: false, error: 'stdio 传输需要 command' };
    }
    if ((req.transport === 'http' || req.transport === 'sse') && !req.url) {
      return { ok: false, error: `${req.transport} 传输需要 url` };
    }
    const info: McpServerInfo = {
      id: req.id,
      transport: req.transport,
      status: 'connecting',
      toolCount: 0,
      sampling: 'ask',
      trusted: false,
    };
    this.servers.set(req.id, { spec: req, info });
    this.persist();
    try {
      const { toolCount } = await this.deps.connect(req);
      info.status = 'connected';
      info.toolCount = toolCount;
      return { ok: true };
    } catch (err) {
      info.status = 'offline';
      info.toolCount = 0;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async remove(id: string): Promise<{ ok: boolean }> {
    const entry = this.servers.get(id);
    if (!entry) return { ok: false };
    try {
      await this.deps.disconnect(id);
    } catch {
      /* 已断开 */
    }
    this.servers.delete(id);
    this.persist();
    return { ok: true };
  }

  async restart(id: string): Promise<{ ok: boolean }> {
    const entry = this.servers.get(id);
    if (!entry) return { ok: false };
    entry.info.status = 'connecting';
    try {
      await this.deps.disconnect(id);
      const { toolCount } = await this.deps.connect(entry.spec);
      entry.info.status = 'connected';
      entry.info.toolCount = toolCount;
      return { ok: true };
    } catch {
      entry.info.status = 'offline';
      return { ok: false };
    }
  }

  /** 更新运行状态（连接层事件回流，如 mcp.server.status）。 */
  setStatus(
    id: string,
    status: McpServerInfo['status'],
    extra?: { toolCount?: number; latencyMs?: number },
  ): void {
    const entry = this.servers.get(id);
    if (!entry) return;
    entry.info.status = status;
    if (extra?.toolCount != null) entry.info.toolCount = extra.toolCount;
    if (extra?.latencyMs != null) entry.info.latencyMs = extra.latencyMs;
  }

  /** 采样三档开关（§10.5⑦）。 */
  setSampling(id: string, mode: 'deny' | 'ask' | 'allow'): void {
    const entry = this.servers.get(id);
    if (entry) entry.info.sampling = mode;
  }

  /** trusted 开关（需二次确认，由 UI 保证）。 */
  setTrusted(id: string, trusted: boolean): void {
    const entry = this.servers.get(id);
    if (entry) entry.info.trusted = trusted;
  }

  /** 允许工具白名单编辑（§10.5⑦ allowedTools）。 */
  setAllowedTools(id: string, tools: string[]): void {
    const entry = this.servers.get(id);
    if (!entry) return;
    (entry.spec as unknown as Record<string, unknown>).allowedTools = tools;
  }

  private persist(): void {
    this.deps.persist([...this.servers.values()].map((s) => s.spec));
  }
}
