/**
 * 引擎工厂：组装 providers / tools / policy / context / sessions / workspace。
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpBridge, type McpServerEntry } from '@mozi/mcp-client';
import { PolicyEngine } from '@mozi/policy';
import type { ProviderRegistry } from '@mozi/providers';
import { createSandbox } from '@mozi/sandbox';
import {
  type AgentEvent,
  type CostLimits,
  type PolicyMode,
  type SandboxRunner,
  checkSessionCost,
  defaultConfig,
} from '@mozi/shared';
import {
  type BrowserAccess,
  type MemoryAccess,
  type VisionAccess,
  Workspace,
  createBuiltinRegistry,
} from '@mozi/tools';
import { ContextManager } from '../context/context-manager.js';
import { loadHooks } from '../hooks/config.js';
import { HookRunner } from '../hooks/runner.js';
import type { ResolvedHook } from '../hooks/types.js';
import { MemoryManager } from '../memory/manager.js';
import { MemoryStore } from '../memory/store.js';
import { PromptAssembler } from '../prompts/assembler.js';
import { type Session, SessionStore } from '../session/session-store.js';
import { type SubAgentConfig, SubAgentSupervisor } from '../subagent/supervisor.js';
import { createTemplateRegistry } from '../subagent/templates.js';
import { ScreenshotService } from '../vision/screenshot.js';
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
  /** 无人值守模式（M13 I1）：策略评估时 ask 一律静态化为 deny。 */
  unattended?: boolean;
  /**
   * 宿主级实时事件出口：所有会话（含子会话桥接事件，如 subagent.approval.required）即时送达。
   * 子 Agent 审批冒泡依赖此通道——父 run() 生成器在等待工具执行期间无法 yield。
   */
  onEvent?: (event: AgentEvent) => void;
  /** M18 钩子：直接注入已加载的执行器（不传则由 factory 按 ~/.mozi + <ws>/.mozi 加载）。 */
  hooks?: HookRunner;
  resolvedHooks?: ResolvedHook[];
  /** M16 记忆存储（不传则按 workspace 自动创建）。 */
  memoryStore?: MemoryStore;
  /** M17 视觉服务（不传则按 workspace 创建 ScreenshotService）。 */
  visionService?: VisionAccess;
  /** 内置浏览器服务（桌面端注入 BrowserService；不传则 browser 工具返回不可用错误）。 */
  browserAccess?: BrowserAccess;
  /** 成本上限（注入后引擎每 turn.completed 评估并发出 cost.warning 事件）。 */
  costLimits?: CostLimits;
  /** 只读/CI 模式：忽略项目级 hooks（§18.5 防线 4）。默认跟随 unattended。 */
  headless?: boolean;
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

  // M15 提示词分层组装器（L0-L3），由 ContextManager 物理拼在 AGENTS.md/记忆之前。
  const prompts = new PromptAssembler();
  // M16 记忆：按 workspace 创建存储 + 管理器（buildInjection 注入 L4）。
  const memoryStore = opts.memoryStore ?? new MemoryStore({ workspace: opts.workspaceRoot });
  const memoryManager = new MemoryManager({ store: memoryStore });
  // M17 视觉：screenshot 服务（落盘 + OCR）。
  const visionService =
    opts.visionService ??
    new ScreenshotService({ mediaDir: path.join(opts.workspaceRoot, '.mozi', 'media') });

  const context = new ContextManager({
    systemPrompt: opts.systemPrompt,
    workspaceRoot: opts.workspaceRoot,
    prompts,
    memory: memoryManager,
    gitBranch: detectGitBranch(opts.workspaceRoot),
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
      roots: () => [{ uri: `file://${opts.workspaceRoot.replace(/\\/g, '/')}`, name: 'workspace' }],
    });
  }

  // M18 钩子：直接注入或按 ~/.mozi + <ws>/.mozi 加载（项目级需审查/指纹确认）。
  let hooks: HookRunner | undefined;
  let resolvedHooks: ResolvedHook[] | undefined;
  if (opts.hooks && opts.resolvedHooks) {
    hooks = opts.hooks;
    resolvedHooks = opts.resolvedHooks;
  } else {
    const loaded = loadHooks({
      workspace: opts.workspaceRoot,
      headless: opts.headless ?? opts.unattended ?? false,
    });
    if (loaded.hooks.length) {
      hooks = new HookRunner({ workspace: opts.workspaceRoot });
      resolvedHooks = loaded.hooks;
    }
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
    evaluateOptions: opts.unattended ? { unattended: true } : undefined,
    memoryManager,
    memoryAccess: memoryAccessFrom(memoryStore),
    visionAccess: visionService,
    browserAccess: opts.browserAccess,
    costLimits: opts.costLimits,
    hooks,
    resolvedHooks,
  };
  const engine = new AgentEngine(deps);
  if (opts.onEvent) engine.setHostEventSink(opts.onEvent);

  // M12 子智能体：构造监督者并回注引擎（引擎 ↔ 监督者循环依赖由此处解耦）。
  const supervisor = new SubAgentSupervisor({
    engine,
    sessions,
    templates: createTemplateRegistry(opts.workspaceRoot),
    config: opts.subagent,
    hooks,
    resolvedHooks,
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

/** 把 MemoryStore 适配为工具侧 MemoryAccess（M16 §16.4：memory_write/search/forget）。 */
function memoryAccessFrom(store: MemoryStore): MemoryAccess {
  return {
    write(req) {
      const r = store.writeExplicit(
        { layer: req.layer, type: req.type, content: req.content, evidence: req.evidence },
        req.evidence,
      );
      return {
        entry: { id: r.entry.id, content: r.entry.content },
        merged: r.merged,
        replaced: r.replaced,
      };
    },
    search(query, opts) {
      return store.search(query, { layer: opts?.layer, limit: opts?.limit }).map((h) => ({
        entry: {
          id: h.entry.id,
          layer: h.entry.layer,
          type: h.entry.type,
          content: h.entry.content,
          source: h.entry.source,
        },
        score: h.score,
      }));
    },
    forget(id) {
      return store.forget(id);
    },
  };
}

/** 安全读取 git 分支（纯 fs，失败返回 undefined；环境层会显示「非 git 仓库或未知」）。 */
function detectGitBranch(workspaceRoot: string): string | undefined {
  try {
    const head = path.join(workspaceRoot, '.git', 'HEAD');
    const ref = fs.readFileSync(head, 'utf8').trim();
    if (ref.startsWith('ref:')) {
      const parts = ref.slice(4).trim().split('/');
      return parts[parts.length - 1] || undefined;
    }
    // detached HEAD：取短 hash
    return ref.slice(0, 8) || undefined;
  } catch {
    return undefined;
  }
}

export type { Session };
export { defaultConfig };
