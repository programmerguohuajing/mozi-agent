import { PolicyEngine } from '@mozi/policy';
import type { ProviderRegistry } from '@mozi/providers';
/**
 * 引擎工厂：组装 providers / tools / policy / context / sessions / workspace。
 */
import { type AgentEvent, type PolicyMode, defaultConfig, type SandboxRunner } from '@mozi/shared';
import { createSandbox } from '@mozi/sandbox';
import { McpBridge, type McpServerEntry } from '@mozi/mcp-client';
import { Workspace, createBuiltinRegistry } from '@mozi/tools';
import { ContextManager } from '../context/context-manager.js';
import { type Session, SessionStore } from '../session/session-store.js';
import { SubAgentSupervisor, type SubAgentConfig } from '../subagent/supervisor.js';
import { createTemplateRegistry } from '../subagent/templates.js';
import { AgentEngine, type EngineDeps } from './agent-engine.js';
import type { ApprovalGateway } from './approve.js';

export interface CreateEngineOptions {
  sessionDir: string;
  workspaceRoot: string;
  providers: ProviderRegistry;
  approval?: ApprovalGateway;
  policyMode?: PolicyMode;
  systemPrompt?: string;
  /** 沙箱等级 0-3；缺省不启用沙箱（与历史行为一致）。 */
  sandboxLevel?: 0 | 1 | 2 | 3;
  /** 沙箱网络白名单（域名）。不传则使用内置默认值。 */
  allowNet?: string[];
  /** MCP server 列表（M8 §8.12）；提供后引擎会在启动时连接并注册其能力。 */
  mcpServers?: McpServerEntry[];
  /** MCP 状态/反向请求事件出口（mcp.server.status 等）。 */
  onMcpEvent?: (event: AgentEvent) => void;
  /** 子智能体配置（M12 §12.5）；不传则使用默认（并发 3 / 深度 2 / 每轮 8）。 */
  subagent?: Partial<SubAgentConfig>;
  /** 是否启用子智能体（task 工具）；默认 true。 */
  enableSubAgents?: boolean;
  /**
   * 宿主级实时事件出口：所有会话（含子会话桥接事件，如 subagent.approval.required）即时送达。
   * 子 Agent 审批冒泡依赖此通道——父 run() 生成器在等待工具执行期间无法 yield。
   */
  onEvent?: (event: AgentEvent) => void;
}

export interface CreatedEngine {
  engine: AgentEngine;
  /** MCP 桥接（未配置 mcpServers 时为 undefined）；宿主据此注册 /mcp: 斜杠命令。 */
  mcp?: McpBridge;
  /** 子智能体监督者（供宿主查询模板 / 子会话）。 */
  supervisor: SubAgentSupervisor;
  /** 关闭引擎持有的外部资源（MCP 连接等）。 */
  dispose(): Promise<void>;
}

/**
 * 组装引擎（同步构造）。MCP 连接是异步的，需调用方 await `connectMcp()` / `createEngineAsync()`。
 */
export function createEngine(opts: CreateEngineOptions): AgentEngine {
  return createEngineInternal(opts).engine;
}

/** 异步工厂：连接 MCP server 并注册其工具/资源/命令（M8 §8.5-8.7）。 */
export async function createEngineAsync(opts: CreateEngineOptions): Promise<CreatedEngine> {
  const created = createEngineInternal(opts);
  if (created.mcp) await created.mcp.connectAll();
  return created;
}

function createEngineInternal(opts: CreateEngineOptions): CreatedEngine {
  const sessions = new SessionStore(opts.sessionDir);
  const workspace = new Workspace(opts.workspaceRoot);
  const policy = new PolicyEngine();
  const context = new ContextManager({
    systemPrompt: opts.systemPrompt,
    workspaceRoot: opts.workspaceRoot,
  });
  const tools = createBuiltinRegistry();

  // M3 沙箱：仅在显式传入 sandboxLevel 时构建，避免改变默认行为。
  let sandbox: SandboxRunner | undefined;
  if (typeof opts.sandboxLevel === 'number') {
    sandbox = createSandbox({ level: opts.sandboxLevel, allowNet: opts.allowNet });
  }

  // M3.5 MCP：仅显式配置时构建桥接，惰性连接由 createEngineAsync 触发。
  let mcp: McpBridge | undefined;
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    mcp = new McpBridge(opts.mcpServers, {
      registry: tools,
      emit: opts.onMcpEvent,
      roots: () => [
        { uri: `file://${opts.workspaceRoot.replace(/\\/g, '/')}`, name: 'workspace' },
      ],
    });
  }

  const deps: EngineDeps = {
    providers: opts.providers,
    tools,
    policy,
    context,
    sessions,
    workspace,
    approval: opts.approval,
    policyMode: opts.policyMode ?? 'auto',
    sandbox,
  };
  const engine = new AgentEngine(deps);
  if (opts.onEvent) engine.setHostEventSink(opts.onEvent);

  // M12 子智能体：构造监督者并回注引擎（引擎 ↔ 监督者循环依赖由此处解耦）。
  const supervisor = new SubAgentSupervisor({
    engine,
    sessions,
    templates: createTemplateRegistry(opts.workspaceRoot),
    config: opts.subagent,
  });
  if (opts.enableSubAgents !== false) {
    deps.supervisor = supervisor;
    engine.attachSupervisor(supervisor);
  }

  return {
    engine,
    mcp,
    supervisor,
    dispose: async () => {
      await mcp?.closeAll();
    },
  };
}

export type { Session };
export { defaultConfig };
