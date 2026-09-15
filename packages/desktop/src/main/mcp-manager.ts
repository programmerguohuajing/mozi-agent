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

  /**
   * 直接编辑 mcp.json（§10.5⑦）：整体替换配置。
   * 校验失败的条目不落盘（返回逐条错误）；成功后对消失的 server 断开连接，
   * 并对全部条目重连验证（编辑后的配置必须真实可用，状态如实反映）。
   */
  async replaceAll(
    specs: McpAddRequest[],
  ): Promise<{ ok: boolean; errors?: Array<{ index: number; error: string }> }> {
    const errors: Array<{ index: number; error: string }> = [];
    const seen = new Set<string>();
    specs.forEach((spec, i) => {
      const err = validateSpec(spec, seen);
      if (err) errors.push({ index: i, error: err });
    });
    if (errors.length > 0) return { ok: false, errors };

    // 断开全部旧连接（消失的删除；保留的也会重连）。
    for (const [id, entry] of [...this.servers.entries()]) {
      try {
        await this.deps.disconnect(id);
      } catch {
        /* 已断开 */
      }
      if (!specs.some((s) => s.id === id)) this.servers.delete(id);
      else entry.info.status = 'connecting';
    }
    // 重建全部条目（sampling / trusted 保留，连接状态重置）。
    for (const spec of specs) {
      const prev = this.servers.get(spec.id);
      this.servers.set(spec.id, {
        spec,
        info: {
          id: spec.id,
          transport: spec.transport,
          status: 'connecting',
          toolCount: 0,
          sampling: prev?.info.sampling ?? 'ask',
          trusted: prev?.info.trusted ?? false,
        },
      });
    }
    this.persist();
    // 逐个重连（失败标记 offline，不阻塞其他 server）。
    for (const spec of specs) {
      const info = this.servers.get(spec.id)?.info;
      if (!info) continue;
      try {
        const { toolCount } = await this.deps.connect(spec);
        info.status = 'connected';
        info.toolCount = toolCount;
      } catch {
        info.status = 'offline';
      }
    }
    return { ok: true };
  }

  /** 完整配置（mcp.json 编辑器数据源）。 */
  config(): McpAddRequest[] {
    return [...this.servers.values()].map((s) => s.spec);
  }

  /** 单条更新（编辑某个 server 的配置）。 */
  async upsert(req: McpAddRequest): Promise<{ ok: boolean; error?: string }> {
    const seen = new Set(this.servers.keys());
    seen.delete(req.id);
    const err = validateSpec(req, seen);
    if (err) return { ok: false, error: err };
    const existed = this.servers.has(req.id);
    if (existed) {
      try {
        await this.deps.disconnect(req.id);
      } catch {
        /* 已断开 */
      }
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
    } catch (e) {
      info.status = 'offline';
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private persist(): void {
    this.deps.persist([...this.servers.values()].map((s) => s.spec));
  }
}

/** 规格校验：与 add() 规则一致 + id 去重。返回错误文案或 null。 */
function validateSpec(spec: McpAddRequest, seen: Set<string>): string | null {
  if (!spec.id?.trim()) return 'id 不能为空';
  if (seen.has(spec.id)) return `id 重复: ${spec.id}`;
  seen.add(spec.id);
  if (spec.transport === 'stdio' && !spec.command?.trim()) return 'stdio 传输需要 command';
  if ((spec.transport === 'http' || spec.transport === 'sse') && !spec.url?.trim()) {
    return `${spec.transport} 传输需要 url`;
  }
  return null;
}
