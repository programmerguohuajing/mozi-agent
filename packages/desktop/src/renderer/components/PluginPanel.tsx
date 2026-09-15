import type { McpAddRequest, McpServerInfo } from '@mozi/protocol';
/**
 * 插件管理面板 — Mozi Studio
 * 三 Tab 展示：内置工具 / MCP 服务 / 子智能体模板。
 * 数据来源：packages/tools 内置 14 个工具 + IPC mcp:list + subagent/templates。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';
import { McpAddForm } from './McpAddForm.js';

// ── 内置工具定义（与 packages/tools/src/registry.ts 的 builtinTools 对齐）──
export interface ToolInfo {
  name: string;
  version: string;
  riskLevel: 'read' | 'write' | 'exec' | 'meta';
  description: string;
  icon: string;
}

const BUILTIN_TOOLS: ToolInfo[] = [
  {
    name: 'read_file',
    version: '1.0.0',
    riskLevel: 'read',
    description: '读取文件内容（带行号），支持 offset/limit；目录则列出条目；自动探测二进制',
    icon: '📄',
  },
  {
    name: 'write_file',
    version: '1.0.0',
    riskLevel: 'write',
    description: '新建或整体覆写文件，自动创建父目录',
    icon: '✏️',
  },
  {
    name: 'edit_file',
    version: '1.0.0',
    riskLevel: 'exec',
    description: '基于结构化 patch 修改已有文件；超 40% 改动用 write_file',
    icon: '📝',
  },
  {
    name: 'glob',
    version: '1.0.0',
    riskLevel: 'read',
    description: '按 glob 模式查找文件路径，支持 ** / * / ?',
    icon: '🔍',
  },
  {
    name: 'grep',
    version: '1.0.0',
    riskLevel: 'read',
    description: '递归正则内容搜索，返回 路径:行号:内容',
    icon: '🔎',
  },
  {
    name: 'shell',
    version: '1.0.0',
    riskLevel: 'exec',
    description: '在工作区执行命令，L1 超时强杀 + 输出截断；沙箱 0-3 级',
    icon: '⬛',
  },
  {
    name: 'todo_list',
    version: '1.0.0',
    riskLevel: 'meta',
    description: '会话级任务清单，支持 list/update，状态 pending/in_progress/done',
    icon: '📋',
  },
  {
    name: 'task',
    version: '1.0.0',
    riskLevel: 'meta',
    description: '派发子智能体执行子任务，隔离上下文；支持并行',
    icon: '🎯',
  },
  {
    name: 'memory_write',
    version: '1.0.0',
    riskLevel: 'write',
    description: '显式持久化记忆（跨会话），layer=user/project；自动去重',
    icon: '🧠',
  },
  {
    name: 'memory_search',
    version: '1.0.0',
    riskLevel: 'read',
    description: '搜索已存储记忆（用户偏好/项目约定/历史决策）',
    icon: '🔍',
  },
  {
    name: 'memory_forget',
    version: '1.0.0',
    riskLevel: 'write',
    description: '按 id 删除记忆条目',
    icon: '🗑️',
  },
  {
    name: 'screenshot',
    version: '1.0.0',
    riskLevel: 'read',
    description: '主动截图获取视觉输入：全屏/窗口/headless 网页 + OCR',
    icon: '📸',
  },
  {
    name: 'git',
    version: '1.0.0',
    riskLevel: 'exec',
    description: '结构化 Git 操作，17 个 action：status/diff/commit/push/pull/merge 等',
    icon: '🌿',
  },
  {
    name: 'browser',
    version: '1.0.0',
    riskLevel: 'read',
    description:
      '内置浏览器（browser use）：navigate/screenshot/click/fill/eval 等 10 个 action，agent 可自主浏览网页（无需手动打开面板）',
    icon: '🌐',
  },
  {
    name: 'mcp_read_resource',
    version: '1.0.0',
    riskLevel: 'read',
    description: '读取 MCP server 暴露的资源（uri）',
    icon: '🔌',
  },
];

// ── 子智能体模板（与 packages/core/src/subagent/templates.ts 对齐）──
export interface AgentTemplate {
  type: string;
  description: string;
  policy: string;
  tools: string;
  allowSubagents: boolean;
  maxSteps: number;
  budget: string;
  timeout: string;
  icon: string;
}

const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    type: 'explore',
    description: '只读代码探索器，广泛搜索/阅读，仅返回结论摘要 + file:line 引用',
    policy: 'readonly',
    tools: 'read_file, glob, grep, list_dir',
    allowSubagents: false,
    maxSteps: 30,
    budget: '32K',
    timeout: '300s',
    icon: '🔍',
  },
  {
    type: 'general',
    description: '通用子智能体，可修改文件，继承父策略（收紧不放宽）',
    policy: 'auto',
    tools: '* (全部)',
    allowSubagents: true,
    maxSteps: 50,
    budget: '64K',
    timeout: '600s',
    icon: '🤖',
  },
  {
    type: 'reviewer',
    description: '只读代码审查员，返回优先级问题清单（severity/file/line/suggestion）',
    policy: 'readonly',
    tools: 'read_file, glob, grep',
    allowSubagents: false,
    maxSteps: 20,
    budget: '32K',
    timeout: '300s',
    icon: '🧐',
  },
];

export interface PluginPanelProps {
  mcpServers: McpServerInfo[];
  onMcpRestart: (id: string) => void;
  onMcpRemove: (id: string) => void;
  onMcpAdd: (req: McpAddRequest) => Promise<{ ok: boolean; error?: string }>;
}

type Tab = 'tools' | 'mcp' | 'agents';

export function PluginPanel(props: PluginPanelProps): React.ReactElement {
  const { t } = useApp();
  const [tab, setTab] = React.useState<Tab>('tools');
  const [showAddForm, setShowAddForm] = React.useState(false);

  const toolCount = BUILTIN_TOOLS.length;
  const mcpCount = props.mcpServers.length;
  const mcpTools = props.mcpServers.reduce((s, m) => s + m.toolCount, 0);
  const agentCount = AGENT_TEMPLATES.length;

  const RISK_STYLES: Record<ToolInfo['riskLevel'], { label: string; cls: string; color: string }> =
    {
      read: { label: t('risk.read'), cls: 'risk-read', color: 'var(--success)' },
      write: { label: t('risk.write'), cls: 'risk-write', color: 'var(--warning)' },
      exec: { label: t('risk.exec'), cls: 'risk-exec', color: 'var(--danger)' },
      meta: { label: t('risk.meta'), cls: 'risk-meta', color: 'var(--info)' },
    };

  const MCP_STATUS: Record<string, { label: string; color: string }> = {
    connected: { label: t('mcp.connected'), color: 'var(--success)' },
    connecting: { label: t('mcp.connecting'), color: 'var(--warning)' },
    disconnected: { label: t('mcp.disconnected'), color: 'var(--text-3)' },
    offline: { label: t('mcp.offline'), color: 'var(--danger)' },
    degraded: { label: t('mcp.degraded'), color: 'var(--warning)' },
  };

  return (
    <div className="page-container">
      <div className="page-title">{t('plugins.title')}</div>
      <div className="page-subtitle">{t('plugins.subtitle')}</div>

      {/* 统计 */}
      <div className="skill-stats">
        <div className="skill-stat">
          <span className="skill-stat-value">{toolCount}</span>
          <span className="skill-stat-label">{t('plugins.stat.builtin')}</span>
        </div>
        <div className="skill-stat">
          <span className="skill-stat-value">{mcpCount}</span>
          <span className="skill-stat-label">{t('plugins.stat.mcp')}</span>
        </div>
        <div className="skill-stat">
          <span className="skill-stat-value">{mcpTools}</span>
          <span className="skill-stat-label">{t('plugins.stat.mcpTools')}</span>
        </div>
        <div className="skill-stat">
          <span className="skill-stat-value">{agentCount}</span>
          <span className="skill-stat-label">{t('plugins.stat.agents')}</span>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="skills-toolbar">
        <div className="skills-filter-group">
          <button
            className={`skill-filter-btn ${tab === 'tools' ? 'active' : ''}`}
            onClick={() => setTab('tools')}
          >
            {t('plugins.tab.tools')} ({toolCount})
          </button>
          <button
            className={`skill-filter-btn ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => setTab('mcp')}
          >
            {t('plugins.tab.mcp')} ({mcpCount})
          </button>
          <button
            className={`skill-filter-btn ${tab === 'agents' ? 'active' : ''}`}
            onClick={() => setTab('agents')}
          >
            {t('plugins.tab.agents')} ({agentCount})
          </button>
        </div>
        {tab === 'mcp' ? (
          <button
            className="btn-sm primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? t('mcp.form.cancel') : t('plugins.mcp.add')}
          </button>
        ) : null}
      </div>

      {/* ── 内置工具 Tab ── */}
      {tab === 'tools' ? (
        <div className="plugin-grid">
          {BUILTIN_TOOLS.map((tool) => {
            const risk = RISK_STYLES[tool.riskLevel];
            return (
              <div
                key={tool.name}
                className="plugin-card"
                style={{ borderLeft: `3px solid ${risk.color}` }}
              >
                <div className="plugin-top">
                  <div className="plugin-icon">{tool.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div className="plugin-name">{tool.name}</div>
                    <div className="plugin-version">v{tool.version}</div>
                  </div>
                  <span
                    className={`risk-badge ${risk.cls}`}
                    style={{ color: risk.color, borderColor: risk.color }}
                  >
                    {risk.label}
                  </span>
                </div>
                <div className="plugin-desc">{tool.description}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* ── MCP 服务 Tab ── */}
      {tab === 'mcp' ? (
        <div>
          {showAddForm ? (
            <McpAddForm onSubmit={props.onMcpAdd} onCancel={() => setShowAddForm(false)} />
          ) : null}
          {props.mcpServers.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🔗</div>
              <div className="empty-state-text">{t('plugins.mcp.empty.title')}</div>
              <div className="empty-state-hint">{t('plugins.mcp.empty.hint')}</div>
            </div>
          ) : (
            <div className="mcp-detail-list">
              {props.mcpServers.map((m) => {
                const status = MCP_STATUS[m.status] ?? MCP_STATUS.disconnected;
                return (
                  <div key={m.id} className="mcp-detail-card">
                    <div className="mcp-detail-top">
                      <span className="mcp-detail-id">{m.id}</span>
                      <span className="mcp-detail-transport">{m.transport}</span>
                      <span className="mcp-detail-status" style={{ color: status.color }}>
                        <span
                          className="status-dot"
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: status.color,
                          }}
                        />
                        {status.label}
                      </span>
                      {m.latencyMs != null ? (
                        <span className="mcp-detail-latency">{m.latencyMs}ms</span>
                      ) : null}
                      <span className="mcp-detail-tools">
                        {m.toolCount} {t('plugins.mcp.tools')}
                      </span>
                      <span className="mcp-detail-sampling">
                        {t('plugins.mcp.sampling')}: {m.sampling ?? 'ask'}
                      </span>
                      {m.trusted ? (
                        <span className="mcp-detail-trusted">{t('plugins.mcp.trusted')}</span>
                      ) : null}
                      <div className="mcp-detail-actions">
                        <button
                          className="btn-sm"
                          title="restart"
                          onClick={() => props.onMcpRestart(m.id)}
                        >
                          {t('plugins.mcp.restart')}
                        </button>
                        <button
                          className="skill-delete-btn"
                          title="移除"
                          onClick={() => props.onMcpRemove(m.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* ── 子智能体模板 Tab ── */}
      {tab === 'agents' ? (
        <div className="plugin-grid">
          {AGENT_TEMPLATES.map((tpl) => (
            <div key={tpl.type} className="plugin-card">
              <div className="plugin-top">
                <div className="plugin-icon">{tpl.icon}</div>
                <div style={{ flex: 1 }}>
                  <div className="plugin-name">{tpl.type}</div>
                  <div className="plugin-version">
                    {t('plugins.agents.policy')}: {tpl.policy}
                  </div>
                </div>
                <span
                  className="risk-badge risk-meta"
                  style={{ color: 'var(--info)', borderColor: 'var(--info)' }}
                >
                  {tpl.allowSubagents ? t('plugins.agents.nested') : t('plugins.agents.leaf')}
                </span>
              </div>
              <div className="plugin-desc">{tpl.description}</div>
              <div className="agent-tpl-meta">
                <div className="agent-tpl-row">
                  <span>{t('plugins.agents.tools')}</span>
                  <code>{tpl.tools}</code>
                </div>
                <div className="agent-tpl-row">
                  <span>{t('plugins.agents.steps')}</span>
                  <code>{tpl.maxSteps}</code>
                </div>
                <div className="agent-tpl-row">
                  <span>{t('plugins.agents.budget')}</span>
                  <code>{tpl.budget}</code>
                </div>
                <div className="agent-tpl-row">
                  <span>{t('plugins.agents.timeout')}</span>
                  <code>{tpl.timeout}</code>
                </div>
              </div>
            </div>
          ))}
          <div className="plugin-card" style={{ opacity: 0.6, borderStyle: 'dashed' }}>
            <div className="plugin-top">
              <div className="plugin-icon">➕</div>
              <div style={{ flex: 1 }}>
                <div className="plugin-name">{t('plugins.agents.custom')}</div>
                <div className="plugin-version">~/.mozi/agents/*.md</div>
              </div>
            </div>
            <div className="plugin-desc">{t('plugins.agents.custom.desc')}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
