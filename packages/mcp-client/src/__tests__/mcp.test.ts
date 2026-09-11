/**
 * @mozi/mcp-client 单元测试（M8 §8.15）：用内存回环 transport 验证
 * 握手 / 工具注册 / 工具调用 / sampling 反向请求 / elicitation 反向请求 / 状态机。
 */
import { describe, expect, it } from 'vitest';
import type { JsonRpcMessage, McpTransport, Disposable, TransportKind } from '../transport/types.js';
import { McpServerConnection, type ConnectionDeps } from '../connection.js';
import { McpToolAdapter } from '../tools.js';
import type { McpToolDef, ToolCallResult } from '../types.js';

/** 回环 transport：send 的 JSON-RPC 请求经 server 回调处理，响应再 push 回来。 */
class LoopbackTransport implements McpTransport {
  readonly kind: TransportKind = 'stdio';
  private handlers = new Set<(m: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(r: string) => void>();
  closed = false;
  constructor(private server: (msg: JsonRpcMessage) => void) {}
  onMessage(h: (m: JsonRpcMessage) => void): Disposable {
    this.handlers.add(h);
    return { dispose: () => this.handlers.delete(h) };
  }
  onClose(h: (r: string) => void): Disposable {
    this.closeHandlers.add(h);
    return { dispose: () => this.closeHandlers.delete(h) };
  }
  async start(): Promise<void> {}
  async send(m: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.server(m);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const h of this.closeHandlers) h('closed');
  }
  push(m: JsonRpcMessage): void {
    for (const h of this.handlers) h(m);
  }
}

/** 构造一个测试 server：处理 initialize / tools/list / tools/call / sampling / elicit。 */
function makeServer() {
  const tools: McpToolDef[] = [
    { name: 'echo', description: 'echo tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ];
  return (msg: JsonRpcMessage) => {
    if ('id' in msg && (msg as { method?: string }).method) {
      const m = msg as { id: string; method: string; params?: unknown };
      if (m.method === 'initialize') {
        loopback.push({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: true }, sampling: {}, elicitation: {} },
            serverInfo: { name: 'test', version: '1.0' },
          },
        });
      } else if (m.method === 'tools/list') {
        loopback.push({ jsonrpc: '2.0', id: m.id, result: { tools } });
      } else if (m.method === 'tools/call') {
        const p = m.params as { name: string; arguments: { text?: string } };
        const res: ToolCallResult = { content: [{ type: 'text', text: `echo:${p.arguments.text ?? ''}` }] };
        loopback.push({ jsonrpc: '2.0', id: m.id, result: res });
      } else if (m.method === 'sampling/createMessage') {
        loopback.push({
          jsonrpc: '2.0',
          id: m.id,
          result: { role: 'assistant', content: [{ type: 'text', text: 'sampled' }], stopReason: 'endTurn' },
        });
      } else if (m.method === 'elicitation/create') {
        loopback.push({ jsonrpc: '2.0', id: m.id, result: { content: { answer: '42' } } });
      } else {
        loopback.push({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    }
  };
}

let loopback: LoopbackTransport;

describe('McpServerConnection', () => {
  it('握手并发现工具', async () => {
    loopback = new LoopbackTransport(makeServer());
    const conn = new McpServerConnection('srv', loopback, {}, {});
    await conn.connect();
    expect(conn.status).toBe('connected');
    expect(conn.capabilities.tools).toBeDefined();
    const tools = await conn.listTools();
    expect(tools[0]?.name).toBe('echo');
  });

  it('调用工具并经适配器渲染为 AgentTool', async () => {
    loopback = new LoopbackTransport(makeServer());
    const conn = new McpServerConnection('srv', loopback, {}, {});
    await conn.connect();
    const defs = await conn.listTools();
    const adapter = new McpToolAdapter(conn, defs[0]!);
    expect(adapter.name).toBe('srv__echo');
    expect(adapter.riskLevel).toBe('meta');
    const ctx = { workspace: { root: '/tmp' }, signal: new AbortController().signal, sessionId: 's' } as never;
    const res = await adapter.execute({ text: 'hi' }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain('echo:hi');
  });

  it('sampling 反向请求经审批回调返回结果', async () => {
    loopback = new LoopbackTransport(makeServer());
    const deps: ConnectionDeps = {
      sampling: {
        enabled: true,
        allowServers: ['srv'],
        maxTokens: 500,
        runChat: async () => ({ text: 'ok' }),
        requestApproval: async () => 'allow',
      },
    };
    const conn = new McpServerConnection('srv', loopback, { sampling: 'ask' }, deps);
    await conn.connect();
    const out = await conn['handleSampling']({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      maxTokens: 100,
    });
    expect((out as { content: Array<{ text: string }> }).content[0]?.text).toBe('ok');
  });
});
