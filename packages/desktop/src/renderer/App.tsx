/**
 * 渲染进程根组件 — Mozi Studio
 * 仿 ChatGPT 桌面端 + 多语言(i18n) + 三套主题(深色/浅色/高对比)。
 */
import * as React from 'react';
import { LoopbackChannel } from '@mozi/protocol';
import type { McpServerInfo, ProviderSummary, SessionSummary, DashboardStats } from '@mozi/protocol';
import type { PolicyMode, PolicyRule, TokenUsage } from '@mozi/shared';
import { UiStore } from '../shared/store.js';
import { AppProvider, useApp, type Locale, type Theme } from './i18n.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Sidebar, type NavTab } from './components/Sidebar.js';
import { SessionView } from './components/SessionView.js';
import { Dashboard } from './components/Dashboard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { SubAgentPanel } from './components/SubAgentPanel.js';
import { SkillPanel, type SkillInfo } from './components/SkillPanel.js';
import { PullRequestPanel, type PRInfo } from './components/PullRequestPanel.js';
import { SchedulePanel, type ScheduleTask } from './components/SchedulePanel.js';
import { PluginPanel } from './components/PluginPanel.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { AnnotationOverlay } from './components/AnnotationOverlay.js';
import { TokenCounter } from './components/TokenCounter.js';

export interface MoziApi {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  versions: { app: string; electron: string; node: string; chrome: string };
}
declare global { interface Window { mozi?: MoziApi } }

// ── Mock data (same as before, kept here for self-contained demo) ──
const BUILTIN_SKILLS: SkillInfo[] = [
  { id: 'code-review', name: '代码审阅', description: '自动审阅代码变更，识别风险、风格问题、安全漏洞', triggers: ['review', '审阅'], category: 'builtin', enabled: true, icon: '🔍', version: '1.0.0' },
  { id: 'git-flow', name: 'Git 工作流', description: '管理 Git 分支、提交、合并请求', triggers: ['git', 'commit'], category: 'builtin', enabled: true, icon: '🌿', version: '1.0.0' },
  { id: 'test-gen', name: '测试生成', description: '根据源码自动生成单元测试', triggers: ['test', '测试'], category: 'builtin', enabled: true, icon: '🧪', version: '1.0.0' },
  { id: 'refactor', name: '重构助手', description: '识别代码异味，建议并执行重构方案', triggers: ['refactor', '重构'], category: 'builtin', enabled: true, icon: '🔧', version: '1.0.0' },
  { id: 'debug-trace', name: '调试追踪', description: '分析错误堆栈，定位根因', triggers: ['debug', 'bug'], category: 'builtin', enabled: true, icon: '🐛', version: '1.0.0' },
  { id: 'security-scan', name: '安全扫描', description: '扫描代码中的安全漏洞', triggers: ['security', '安全'], category: 'builtin', enabled: false, icon: '🛡️', version: '1.0.0' },
  { id: 'doc-gen', name: '文档生成', description: '从代码注释提取文档，生成 API 参考', triggers: ['doc', '文档'], category: 'builtin', enabled: false, icon: '📄', version: '1.0.0' },
  { id: 'perf-optimize', name: '性能优化', description: '分析性能瓶颈，建议优化策略', triggers: ['perf', '性能'], category: 'builtin', enabled: false, icon: '⚡', version: '1.0.0' },
];

const MOCK_PRS: PRInfo[] = [
  { id: 42, title: 'feat: 重构会话池支持多窗口聚焦', branch: 'feature/multi-window', status: 'open', additions: 340, deletions: 82, changedFiles: 6, author: 'mozi', updatedAt: '2026-09-12T01:00:00Z', project: 'mozi-agent' },
  { id: 41, title: 'fix: 修复 cron 时区计算导致 once 任务错过', branch: 'fix/cron-tz', status: 'merged', additions: 45, deletions: 18, changedFiles: 3, author: 'mozi', updatedAt: '2026-09-11T18:30:00Z', project: 'mozi-agent' },
  { id: 40, title: 'feat: 截图标注覆盖层组件', branch: 'feature/annotation', status: 'open', additions: 280, deletions: 0, changedFiles: 4, author: 'mozi', updatedAt: '2026-09-11T17:00:00Z', project: 'mozi-agent' },
  { id: 39, title: 'chore: 开源运营与评测体系', branch: 'chore/m5-ops', status: 'draft', additions: 1200, deletions: 50, changedFiles: 12, author: 'mozi', updatedAt: '2026-09-10T14:00:00Z', project: 'mozi-agent' },
];

const MOCK_SCHEDULES: ScheduleTask[] = [
  { id: 'sched-1', name: '每日招标商机扫描', cron: '0 9 * * *', nextRun: '2026-09-12 09:00', enabled: true, lastStatus: 'success', project: 'mozi-agent' },
  { id: 'sched-2', name: '每周代码质量报告', cron: '0 10 * * 1', nextRun: '2026-09-15 10:00', enabled: true, lastStatus: 'success', project: 'mozi-agent' },
  { id: 'sched-3', name: '每小时依赖安全检查', cron: '0 * * * *', nextRun: '2026-09-12 02:00', enabled: false, lastStatus: 'failed', project: 'mozi-agent' },
];

const MODELS = [
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'deepseek-v3', label: 'DeepSeek V3' },
  { id: 'qwen-max', label: 'Qwen Max' },
];

// ── Inner App (uses useApp for i18n + theme) ──
function AppInner({ api }: { api: MoziApi }): React.ReactElement {
  const ctx = useApp();
  const t = ctx?.t ?? ((k: string) => k);
  const { locale, theme, setTheme, setLocale } = ctx ?? { locale: 'zh' as Locale, theme: 'dark' as Theme, setTheme: () => {}, setLocale: () => {} };
  const store = React.useMemo(() => new UiStore(), []);
  const [state, setState] = React.useState(store.getState());
  const [nav, setNav] = React.useState<NavTab>('chat');
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [policyMode, setPolicyMode] = React.useState<PolicyMode>('auto');
  const [policyRules, setPolicyRules] = React.useState<PolicyRule[]>([]);
  const [mcpServers, setMcpServers] = React.useState<McpServerInfo[]>([]);
  const [sandboxLevel, setSandboxLevel] = React.useState<0 | 1 | 2 | 3>(1);
  const [costLimits, setCostLimits] = React.useState<{ perSessionUsd?: number; perDayUsd?: number }>({});
  const [stats, setStats] = React.useState<DashboardStats>({ tokensByDay: [], toolCalls: [], approvals: { allow: 0, deny: 0 }, costByModel: [] });
  const [input, setInput] = React.useState('');
  const [attachments, setAttachments] = React.useState<Array<{ contentId: string; base64: string; thumbnail: string }>>([]);
  const [annotation, setAnnotation] = React.useState<{ base64: string; width: number; height: number } | null>(null);
  const [skills, setSkills] = React.useState<SkillInfo[]>(BUILTIN_SKILLS);
  const [model, setModel] = React.useState('claude-sonnet-4');
  const [prs] = React.useState<PRInfo[]>(MOCK_PRS);
  const [schedules, setSchedules] = React.useState<ScheduleTask[]>(MOCK_SCHEDULES);
  const [showThemeMenu, setShowThemeMenu] = React.useState(false);

  React.useEffect(() => store.subscribe(setState), [store]);

  React.useEffect(() => {
    const offEvent = api.on('engine:event', (p) => {
      store.apply((p as { sessionId: string; event: never }).sessionId, (p as { event: never }).event);
      // 事件流会改变仪表盘聚合（token/工具调用/审批），节流后重取。
      scheduleStatsRefresh();
    });
    const offStatus = api.on('session:status', (p) => store.status((p as { sessionId: string }).sessionId, (p as { state: never }).state));
    void refresh();
    return () => { offEvent(); offStatus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 仪表盘统计：从后端真实聚合，未产生任何会话事件时为空。 */
  const refreshStats = async (): Promise<void> => {
    const dash = (await api.invoke('dashboard:stats', {})) as DashboardStats;
    setStats(dash ?? { tokensByDay: [], toolCalls: [], approvals: { allow: 0, deny: 0 }, costByModel: [] });
  };

  // 事件频繁时避免每次都打 IPC：合并到一次尾随调用。
  const statsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsRefresh = (): void => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => { void refreshStats(); }, 400);
  };
  React.useEffect(() => () => { if (statsTimer.current) clearTimeout(statsTimer.current); }, []);

  /** 输入框随内容增高（1 行起步，最多 120px），避免固定行数把输入栏整体撑高。 */
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 120)}px`;
  }, [input]);

  const refresh = async (): Promise<void> => {
    const sessions = (await api.invoke('session:list', {})) as SessionSummary[];
    store.setSessions(sessions);
    const cfg = (await api.invoke('config:get', {})) as { providers: ProviderSummary[]; policyMode: PolicyMode; settings: Record<string, unknown> };
    setProviders(cfg.providers);
    setPolicyMode(cfg.policyMode);
    setPolicyRules((cfg.settings.policyRules as PolicyRule[]) ?? []);
    setSandboxLevel((cfg.settings.sandboxLevel as 0 | 1 | 2 | 3) ?? 1);
    setCostLimits((cfg.settings.costLimits as { perSessionUsd?: number; perDayUsd?: number }) ?? {});
    setMcpServers((await api.invoke('mcp:list', {})) as McpServerInfo[]);
    await refreshStats();
  };

  const activeView = state.activeSessionId ? state.views[state.activeSessionId] : undefined;
  const activeUsage: TokenUsage | undefined = activeView?.usage;

  const newSession = async (): Promise<void> => {
    const created = (await api.invoke('session:create', { workspaceRoot: (await promptWorkspace()) ?? '.' })) as SessionSummary;
    await refresh();
    store.setActive(created.id);
    setNav('chat');
  };

  const send = async (): Promise<void> => {
    if (!input.trim() || !state.activeSessionId) return;
    const text = input;
    setInput('');
    const att = attachments.length > 0 ? `\n[附件 ${attachments.length} 张]` : '';
    setAttachments([]);
    await api.invoke('run:start', { sessionId: state.activeSessionId, text: text + att });
  };

  const captureAndAnnotate = async (): Promise<void> => {
    const r = (await api.invoke('browser:capture', {})) as { base64?: string; width?: number; height?: number; error?: string };
    if (r.error || !r.base64) return;
    setAnnotation({ base64: r.base64, width: r.width ?? 1200, height: r.height ?? 800 });
  };

  const onAnnotationConfirm = async (b64: string): Promise<void> => {
    const result = (await api.invoke('browser:saveAnnotated', { base64: b64, sessionId: state.activeSessionId })) as { ok: boolean; contentId: string };
    if (result.ok) setAttachments((prev) => [...prev, { contentId: result.contentId, base64: b64, thumbnail: `data:image/png;base64,${b64.slice(0, 1000)}` }]);
    setAnnotation(null);
  };

  const headerTabs: Array<{ key: NavTab; label: string }> = [
    { key: 'chat', label: t('tab.chat') },
    { key: 'subagents', label: t('tab.subagents') },
    { key: 'dashboard', label: t('tab.dashboard') },
    { key: 'settings', label: t('tab.settings') },
  ];
  const showHeaderTabs = nav === 'chat' || nav === 'subagents' || nav === 'dashboard' || nav === 'settings';

  const themes: Array<{ key: Theme; label: string; icon: string }> = [
    { key: 'dark', label: t('theme.dark'), icon: '🌙' },
    { key: 'light', label: t('theme.light'), icon: '☀️' },
    { key: 'contrast', label: t('theme.contrast'), icon: '◯' },
  ];

  return (
    <div className="app">
      <Sidebar
        sessions={state.sessions}
        {...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {})}
        activeNav={nav}
        onNavChange={setNav}
        onSelect={(id) => { void api.invoke('session:resume', { sessionId: id }); store.setActive(id); setNav('chat'); }}
        onNew={() => void newSession()}
        onDelete={(id) => void api.invoke('session:delete', { sessionId: id }).then(refresh)}
        onFork={(id) => void api.invoke('session:fork', { sessionId: id }).then(refresh)}
      />

      <main className="main">
        <header className="header">
          {showHeaderTabs ? headerTabs.map((tb) => (
            <button key={tb.key} className={`tab ${nav === tb.key ? 'active' : ''}`} onClick={() => setNav(tb.key)}>{tb.label}</button>
          )) : null}
          <div className="header-right">
            {/* Language switcher */}
            <button className="switcher-btn" onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')} title={t('lang.toggle')}>
              {locale === 'zh' ? 'EN' : '中'}
            </button>
            {/* Theme dropdown */}
            <div className="theme-dropdown">
              <button className="switcher-btn" onClick={() => setShowThemeMenu(!showThemeMenu)} title={t('theme.toggle')}>
                {themes.find((th) => th.key === theme)?.icon} {themes.find((th) => th.key === theme)?.label}
              </button>
              {showThemeMenu ? (
                <div className="theme-dropdown-menu">
                  {themes.map((th) => (
                    <div key={th.key} className={`theme-dropdown-item ${theme === th.key ? 'active' : ''}`}
                      onClick={() => { setTheme(th.key); setShowThemeMenu(false); }}>
                      <span className={`theme-dot ${th.key}`}></span>
                      {th.icon} {th.label}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="status-chip">
              <span className={`status-dot ${activeView?.state ?? 'idle'}`}></span>
              <span>{activeView ? t(`status.${activeView.state}`) : t('status.idle')}</span>
            </div>
            <TokenCounter
              {...(activeUsage ? { usage: activeUsage } : {})}
              running={activeView?.state === 'running'}
              {...(costLimits.perSessionUsd ? { costLimitUsd: costLimits.perSessionUsd } : {})}
            />
          </div>
        </header>

        {nav === 'chat' && state.activeSessionId ? (
          <div className="breadcrumb">
            <a onClick={() => setNav('chat')}>{t('session.breadcrumb.home')}</a>
            <span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">
              {state.sessions.find((s) => s.id === state.activeSessionId)?.project ?? t('tab.chat')}
            </span>
            <div className="breadcrumb-actions">
              <button className="breadcrumb-btn">{t('session.share')}</button>
            </div>
          </div>
        ) : null}

        <div className="content">
          {nav === 'chat' && activeView ? (
            <SessionView view={activeView} onResolveApproval={(callId, decision, opts) => {
              void api.invoke('approval:resolve', { sessionId: state.activeSessionId, callId, decision, ...(opts?.onceForSession ? { onceForSession: true } : {}) });
            }} />
          ) : null}
          {nav === 'chat' && !activeView ? (
            <div className="empty-state">
              <div className="empty-state-icon">💬</div>
              <div className="empty-state-text">{t('session.empty.title')}</div>
              <div className="empty-state-hint">{t('session.empty.hint')}</div>
            </div>
          ) : null}
          {nav === 'subagents' && state.activeSessionId ? (
            <SubAgentPanel parentSessionId={state.activeSessionId} nodes={activeView?.subagents ?? []}
              loadSubSession={async (sid) => ((await api.invoke('session:resume', { sessionId: sid })) as unknown as import('@mozi/shared').AgentEvent[]) ?? []}
            />
          ) : null}
          {nav === 'subagents' && !state.activeSessionId ? (
            <div className="empty-state"><div className="empty-state-icon">🤖</div><div className="empty-state-text">{t('subagent.empty.title')}</div></div>
          ) : null}
          {nav === 'skills' ? (
            <SkillPanel skills={skills} onToggle={(id) => setSkills((p) => p.map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s))}
              onImport={(fp) => { const n = fp.split(/[\\/]/).pop()?.replace(/\.json$/, '') ?? 'imported'; setSkills((p) => [...p, { id: `imp-${Date.now().toString(36)}`, name: n, description: `从 ${fp} 导入`, triggers: [n], category: 'imported', enabled: true, source: fp, icon: '📥' }]); }}
              onImportJson={(j) => { const d = JSON.parse(j); setSkills((p) => [...p, { id: `imp-${Date.now().toString(36)}`, name: d.name ?? 'unnamed', description: d.description ?? '', triggers: d.triggers ?? [], category: 'imported', enabled: true, source: 'json', icon: d.icon ?? '🧩', version: d.version }]); }}
              onDelete={(id) => setSkills((p) => p.filter((s) => s.id !== id))} />
          ) : null}
          {nav === 'pulls' ? <PullRequestPanel prs={prs} /> : null}
          {nav === 'schedule' ? (
            <SchedulePanel tasks={schedules} onToggle={(id) => setSchedules((p) => p.map((ts) => ts.id === id ? { ...ts, enabled: !ts.enabled } : ts))}
              onDelete={(id) => setSchedules((p) => p.filter((ts) => ts.id !== id))} onCreate={() => {}} />
          ) : null}
          {nav === 'plugins' ? (
            <PluginPanel mcpServers={mcpServers}
              onMcpRestart={(id) => void api.invoke('mcp:restart', { id }).then(refresh)}
              onMcpRemove={(id) => void api.invoke('mcp:remove', { id }).then(refresh)}
              onMcpAdd={() => {}} />
          ) : null}
          {nav === 'security' ? (
            <SecurityPanel sandboxLevel={sandboxLevel} policyMode={policyMode}
              approvalStats={stats.approvals}
              onSetSandboxLevel={(lvl) => { setSandboxLevel(lvl); void api.invoke('config:set', { patch: { sandboxLevel: lvl } }); }} />
          ) : null}
          {nav === 'dashboard' ? <Dashboard stats={stats} /> : null}
          {nav === 'settings' ? (
            <SettingsPanel providers={providers} policyMode={policyMode} policyRules={policyRules} mcpServers={mcpServers}
              sandboxLevel={sandboxLevel} costLimits={costLimits}
              onSetProviderKey={(id, secret) => void api.invoke('config:set', { patch: { pendingKey: { id, secret } } }).then(refresh)}
              onTestProvider={async (id) => (await api.invoke('config:testProvider', { providerId: id })) as { ok: boolean; latencyMs?: number; error?: string }}
              onSetPolicyMode={(m) => { setPolicyMode(m); void api.invoke('config:set', { patch: { policyMode: m } }); }}
              onSetPolicyRules={(r) => { setPolicyRules(r); void api.invoke('config:set', { patch: { policyRules: r } }); }}
              onSetSandboxLevel={(l) => { setSandboxLevel(l); void api.invoke('config:set', { patch: { sandboxLevel: l } }); }}
              onSetCostLimits={(lim) => { setCostLimits(lim); void api.invoke('config:set', { patch: { costLimits: lim } }); }} />
          ) : null}
        </div>

        {nav === 'chat' && activeView ? (
          <div className="input-bar">
            {attachments.length > 0 ? (
              <div className="input-attachments">
                {attachments.map((a) => (
                  <div key={a.contentId} className="attachment-thumb">
                    <img src={`data:image/png;base64,${a.base64}`} alt="screenshot" />
                    <button className="attachment-remove" onClick={() => setAttachments((p) => p.filter((x) => x.contentId !== a.contentId))}>✕</button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="input-row">
              <textarea ref={inputRef} rows={1} className="input-textarea" placeholder={t('chat.input.placeholder')}
                value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <button className="btn-tool" title={t('chat.screenshot.hint')} aria-label={t('chat.screenshot.hint')}
                onClick={() => void captureAndAnnotate()}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.6 6.4A1.6 1.6 0 0 1 4.2 4.9h1.3l0.9 -1.6h3.2l0.9 1.6h1.3a1.6 1.6 0 0 1 1.6 1.5v5.4a1.6 1.6 0 0 1 -1.6 1.6H4.2a1.6 1.6 0 0 1 -1.6 -1.6z" />
                  <circle cx="8" cy="9.2" r="2.3" />
                </svg>
                {t('chat.screenshot')}
              </button>
              <div className="model-selector">
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
              <span className="perm-badge full">{t('chat.permission.full')}</span>
              <button className="btn-send" onClick={() => void send()}>{t('chat.send')}</button>
              <button className="btn-abort" onClick={() => void api.invoke('engine:abort', { sessionId: state.activeSessionId })}>{t('chat.abort')}</button>
            </div>
          </div>
        ) : null}

        {annotation ? (
          <AnnotationOverlay screenshotBase64={annotation.base64} width={annotation.width} height={annotation.height}
            onConfirm={(b) => void onAnnotationConfirm(b)} onCancel={() => setAnnotation(null)} />
        ) : null}
      </main>
    </div>
  );
}

// ── Exported App wrapper (provides context) ──
export function App({ api }: { api: MoziApi }): React.ReactElement {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppInner api={api} />
      </AppProvider>
    </ErrorBoundary>
  );
}

async function promptWorkspace(): Promise<string | null> {
  try { return globalThis.prompt?.('workspace 目录') ?? null; } catch { return null; }
}

export function createClient(api: MoziApi): LoopbackChannel { const bus = new LoopbackChannel(); void api; return bus; }
