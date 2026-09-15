import { LoopbackChannel } from '@mozi/protocol';
import type {
  DashboardStats,
  McpAddRequest,
  McpServerInfo,
  ProviderSummary,
  ScheduleTaskInfo,
  SessionSummary,
  SkillSummary,
} from '@mozi/protocol';
import type { AgentEvent, PolicyMode, PolicyRule, TokenUsage } from '@mozi/shared';
/**
 * 渲染进程根组件 — Mozi Studio
 * 仿 ChatGPT 桌面端 + 多语言(i18n) + 三套主题(深色/浅色/高对比)。
 */
import * as React from 'react';
import { UiStore } from '../shared/store.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { AnnotationOverlay } from './components/AnnotationOverlay.js';
import { type BrowserCaptureFn, BrowserPanel } from './components/BrowserPanel.js';
import { Dashboard } from './components/Dashboard.js';
import { InputBar } from './components/InputBar.js';
import { PluginPanel } from './components/PluginPanel.js';
import { type PRInfo, PullRequestPanel } from './components/PullRequestPanel.js';
import { SchedulePanel } from './components/SchedulePanel.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { Select, type SelectOption } from './components/Select.js';
import { SessionView } from './components/SessionView.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { type NavTab, Sidebar } from './components/Sidebar.js';
import { type SkillInfo, SkillPanel } from './components/SkillPanel.js';
import { SubAgentPanel } from './components/SubAgentPanel.js';
import { TokenCounter } from './components/TokenCounter.js';
import { AppProvider, type Locale, type Theme, useApp } from './i18n.js';

export interface MoziApi {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  versions: { app: string; electron: string; node: string; chrome: string };
}
declare global {
  interface Window {
    mozi?: MoziApi;
  }
}

// ── Mock data (same as before, kept here for self-contained demo) ──
const BUILTIN_SKILLS: SkillInfo[] = [
  {
    id: 'code-review',
    name: '代码审阅',
    description: '自动审阅代码变更，识别风险、风格问题、安全漏洞',
    triggers: ['review', '审阅'],
    category: 'builtin',
    enabled: true,
    icon: '🔍',
    version: '1.0.0',
  },
  {
    id: 'git-flow',
    name: 'Git 工作流',
    description: '管理 Git 分支、提交、合并请求',
    triggers: ['git', 'commit'],
    category: 'builtin',
    enabled: true,
    icon: '🌿',
    version: '1.0.0',
  },
  {
    id: 'test-gen',
    name: '测试生成',
    description: '根据源码自动生成单元测试',
    triggers: ['test', '测试'],
    category: 'builtin',
    enabled: true,
    icon: '🧪',
    version: '1.0.0',
  },
  {
    id: 'refactor',
    name: '重构助手',
    description: '识别代码异味，建议并执行重构方案',
    triggers: ['refactor', '重构'],
    category: 'builtin',
    enabled: true,
    icon: '🔧',
    version: '1.0.0',
  },
  {
    id: 'debug-trace',
    name: '调试追踪',
    description: '分析错误堆栈，定位根因',
    triggers: ['debug', 'bug'],
    category: 'builtin',
    enabled: true,
    icon: '🐛',
    version: '1.0.0',
  },
  {
    id: 'security-scan',
    name: '安全扫描',
    description: '扫描代码中的安全漏洞',
    triggers: ['security', '安全'],
    category: 'builtin',
    enabled: false,
    icon: '🛡️',
    version: '1.0.0',
  },
  {
    id: 'doc-gen',
    name: '文档生成',
    description: '从代码注释提取文档，生成 API 参考',
    triggers: ['doc', '文档'],
    category: 'builtin',
    enabled: false,
    icon: '📄',
    version: '1.0.0',
  },
  {
    id: 'perf-optimize',
    name: '性能优化',
    description: '分析性能瓶颈，建议优化策略',
    triggers: ['perf', '性能'],
    category: 'builtin',
    enabled: false,
    icon: '⚡',
    version: '1.0.0',
  },
];

const MOCK_PRS: PRInfo[] = [
  {
    id: 42,
    title: 'feat: 重构会话池支持多窗口聚焦',
    branch: 'feature/multi-window',
    status: 'open',
    additions: 340,
    deletions: 82,
    changedFiles: 6,
    author: 'mozi',
    updatedAt: '2026-09-12T01:00:00Z',
    project: 'mozi-agent',
  },
  {
    id: 41,
    title: 'fix: 修复 cron 时区计算导致 once 任务错过',
    branch: 'fix/cron-tz',
    status: 'merged',
    additions: 45,
    deletions: 18,
    changedFiles: 3,
    author: 'mozi',
    updatedAt: '2026-09-11T18:30:00Z',
    project: 'mozi-agent',
  },
  {
    id: 40,
    title: 'feat: 截图标注覆盖层组件',
    branch: 'feature/annotation',
    status: 'open',
    additions: 280,
    deletions: 0,
    changedFiles: 4,
    author: 'mozi',
    updatedAt: '2026-09-11T17:00:00Z',
    project: 'mozi-agent',
  },
  {
    id: 39,
    title: 'chore: 开源运营与评测体系',
    branch: 'chore/m5-ops',
    status: 'draft',
    additions: 1200,
    deletions: 50,
    changedFiles: 12,
    author: 'mozi',
    updatedAt: '2026-09-10T14:00:00Z',
    project: 'mozi-agent',
  },
];

// 预设模型回退列表（用户尚未配置 Provider 时使用）
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'deepseek-v3', label: 'DeepSeek V3' },
  { id: 'qwen-max', label: 'Qwen Max' },
];

/** 计划模式允许的只读工具（引擎侧 enabledTools 白名单，双保险）。 */
const PLAN_MODE_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'list_dir',
  'todo_list',
  'task',
  'memory_search',
  'browser',
  'screenshot',
  'mcp_read_resource',
];

// ── Inner App (uses useApp for i18n + theme) ──
function AppInner({ api }: { api: MoziApi }): React.ReactElement {
  const ctx = useApp();
  const t = ctx?.t ?? ((k: string) => k);
  const { locale, theme, setTheme, setLocale } = ctx ?? {
    locale: 'zh' as Locale,
    theme: 'dark' as Theme,
    setTheme: () => {},
    setLocale: () => {},
  };
  const store = React.useMemo(() => new UiStore(), []);
  const [state, setState] = React.useState(store.getState());
  const [nav, setNav] = React.useState<NavTab>('chat');
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [policyMode, setPolicyMode] = React.useState<PolicyMode>('auto');
  const [policyRules, setPolicyRules] = React.useState<PolicyRule[]>([]);
  const [mcpServers, setMcpServers] = React.useState<McpServerInfo[]>([]);
  const [sandboxLevel, setSandboxLevel] = React.useState<0 | 1 | 2 | 3>(1);
  const [closeBehavior, setCloseBehavior] = React.useState<'quit' | 'tray'>('tray');
  const [costLimits, setCostLimits] = React.useState<{
    perSessionUsd?: number;
    perDayUsd?: number;
  }>({});
  const [stats, setStats] = React.useState<DashboardStats>({
    tokensByDay: [],
    toolCalls: [],
    approvals: { allow: 0, deny: 0 },
    costByModel: [],
  });
  const [input, setInput] = React.useState('');
  const [attachments, setAttachments] = React.useState<
    Array<{ contentId: string; base64: string; thumbnail: string }>
  >([]);
  const [annotation, setAnnotation] = React.useState<{
    base64: string;
    width: number;
    height: number;
  } | null>(null);
  const [captureError, setCaptureError] = React.useState<string | null>(null);
  // 技能管理页（SkillPanel）的 mock 数据源。
  const [panelSkills, setPanelSkills] = React.useState<SkillInfo[]>(BUILTIN_SKILLS);
  const [model, setModel] = React.useState('');
  const [prs] = React.useState<PRInfo[]>(MOCK_PRS);
  // ── 定时任务（真实数据源：TaskSchedulerHost → schedule:* 通道）──
  const [schedules, setSchedules] = React.useState<ScheduleTaskInfo[]>([]);
  /** 手动触发「立即运行」中的任务 id（进行时反馈）。 */
  const [scheduleRunningIds, setScheduleRunningIds] = React.useState<string[]>([]);
  const [showThemeMenu, setShowThemeMenu] = React.useState(false);
  // 中止请求进行中（防重复点击 + 按钮反馈）。
  const [aborting, setAborting] = React.useState(false);
  // 中止失败的错误提示（会话不在运行 / 已销毁等）。
  const [abortError, setAbortError] = React.useState<string | null>(null);
  // ── 输入栏扩展能力：计划模式 / 技能勾选 / MCP 勾选 ──
  // 计划模式：只规划不动手（只读工具 + readonly 策略 + 指令前缀）。
  const [planMode, setPlanMode] = React.useState(false);
  // 本地技能（skills:list：内置 + ~/.mozi/skills + 项目 .mozi/skills）。
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  const [selectedSkills, setSelectedSkills] = React.useState<string[]>([]);
  // 本任务勾选的 MCP 服务（信息性指示，随消息下发）。
  const [selectedMcp, setSelectedMcp] = React.useState<string[]>([]);
  // 新建后尚未显式选择项目文件夹的会话（输入栏高亮引导）。
  const [unsetWorkspaceIds, setUnsetWorkspaceIds] = React.useState<Set<string>>(new Set());
  // ── 任务浏览器面板（每会话独立开关）──
  // 打开后：会话视图右侧分栏内嵌 webview；agent 的 browser 工具操作同一页面；
  // 输入栏「截图」按钮仅在浏览器打开时显示（截取 webview 当前页面）。
  const [browserSessions, setBrowserSessions] = React.useState<Record<string, boolean>>({});
  const browserCaptureRef = React.useRef<BrowserCaptureFn | null>(null);

  React.useEffect(() => store.subscribe(setState), [store]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 一次性全局事件订阅，卸载时注销，api/store 为稳定单例。
  React.useEffect(() => {
    const offEvent = api.on('engine:event', (p) => {
      store.apply(
        (p as { sessionId: string; event: never }).sessionId,
        (p as { event: never }).event,
      );
      // 事件流会改变仪表盘聚合（token/工具调用/审批），节流后重取。
      scheduleStatsRefresh();
    });
    const offStatus = api.on('session:status', (p) =>
      store.status((p as { sessionId: string }).sessionId, (p as { state: never }).state),
    );
    // 定时任务状态变化（tick 到期 / 启停 / 删除 / 运行完成）→ 自动重取列表。
    const offSched = api.on('schedule:changed', () => void refreshSchedules());
    void refresh();
    return () => {
      offEvent();
      offStatus();
      offSched();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 仪表盘统计：从后端真实聚合，未产生任何会话事件时为空。 */
  const refreshStats = async (): Promise<void> => {
    const dash = (await api.invoke('dashboard:stats', {})) as DashboardStats;
    setStats(
      dash ?? { tokensByDay: [], toolCalls: [], approvals: { allow: 0, deny: 0 }, costByModel: [] },
    );
  };

  // 事件频繁时避免每次都打 IPC：合并到一次尾随调用。
  const statsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsRefresh = (): void => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      void refreshStats();
    }, 400);
  };
  React.useEffect(
    () => () => {
      if (statsTimer.current) clearTimeout(statsTimer.current);
    },
    [],
  );

  /** 输入框随内容增高的逻辑已随 InputBar 组件迁移（组件内维护）。 */

  const refresh = async (): Promise<void> => {
    const sessions = (await api.invoke('session:list', {})) as SessionSummary[];
    store.setSessions(sessions);
    const cfg = (await api.invoke('config:get', {})) as {
      providers: ProviderSummary[];
      policyMode: PolicyMode;
      settings: Record<string, unknown>;
    };
    setProviders(cfg.providers);
    // 模型选择器展平为 provider × models：首次加载自动选中第一项
    if (cfg.providers.length > 0 && !model) {
      const first = cfg.providers[0]!;
      setModel(`${first.id}::${first.models?.[0] ?? first.model}`);
    } else if (cfg.providers.length === 0 && !model) {
      setModel(FALLBACK_MODELS[0]!.id);
    }
    setPolicyMode(cfg.policyMode);
    setPolicyRules((cfg.settings.policyRules as PolicyRule[]) ?? []);
    setSandboxLevel((cfg.settings.sandboxLevel as 0 | 1 | 2 | 3) ?? 1);
    setCloseBehavior((cfg.settings.closeBehavior as 'quit' | 'tray') ?? 'tray');
    setCostLimits(
      (cfg.settings.costLimits as { perSessionUsd?: number; perDayUsd?: number }) ?? {},
    );
    setMcpServers((await api.invoke('mcp:list', {})) as McpServerInfo[]);
    // 定时任务（TaskSchedulerHost 真实数据）。
    setSchedules(((await api.invoke('schedule:list', {})) as ScheduleTaskInfo[]) ?? []);
    await refreshStats();
  };

  /** 只刷新定时任务列表（任务状态变化时轻量重取）。 */
  const refreshSchedules = async (): Promise<void> => {
    setSchedules(((await api.invoke('schedule:list', {})) as ScheduleTaskInfo[]) ?? []);
  };

  const activeView = state.activeSessionId ? state.views[state.activeSessionId] : undefined;
  const activeUsage: TokenUsage | undefined = activeView?.usage;
  const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
  // 当前会话的浏览器面板开关（每会话独立；agent 与用户共用同一页面）。
  const browserOpen = state.activeSessionId
    ? Boolean(browserSessions[state.activeSessionId])
    : false;

  const toggleBrowser = (): void => {
    const sid = state.activeSessionId;
    if (!sid) return;
    setBrowserSessions((prev) => ({ ...prev, [sid]: !prev[sid] }));
  };

  // 技能列表随会话（workspace）变化：项目级 .mozi/skills 需重新扫描。
  React.useEffect(() => {
    if (!state.activeSessionId) return undefined;
    void api
      .invoke('skills:list', { sessionId: state.activeSessionId })
      .then((r) => setSkills((r as SkillSummary[]) ?? []))
      .catch(() => setSkills([]));
    return undefined;
  }, [state.activeSessionId, api]);

  const newSession = async (): Promise<void> => {
    // 新建任务：直接创建（不再先弹目录选择框）；
    // 项目文件夹由输入栏「+」→ 选择项目文件夹 随时补充/更换。
    const created = (await api.invoke('session:create', {})) as SessionSummary;
    await refresh();
    store.setActive(created.id);
    setNav('chat');
    setUnsetWorkspaceIds((prev) => new Set(prev).add(created.id));
  };

  /** 为当前任务选择/更换项目文件夹：原生目录选择框 → session:setWorkspace。 */
  const pickWorkspaceForSession = async (): Promise<void> => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const picked = (await api.invoke('workspace:pick', {})) as {
      ok: boolean;
      path?: string;
      canceled?: boolean;
      error?: string;
    };
    if (!picked.ok || picked.canceled || !picked.path) {
      if (picked.error) setAbortError(picked.error);
      return;
    }
    const r = (await api.invoke('session:setWorkspace', {
      sessionId,
      workspaceRoot: picked.path,
    })) as { ok: boolean; error?: string };
    if (!r.ok) {
      setAbortError(r.error ?? '切换项目文件夹失败');
      return;
    }
    setUnsetWorkspaceIds((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    await refresh();
  };

  /** 中止当前任务（§10.3 engine:abort）：中断 LLM 流 / 工具执行 / 审批等待。 */
  const abortRun = async (): Promise<void> => {
    const sessionId = state.activeSessionId;
    if (!sessionId || aborting) return;
    setAborting(true);
    setAbortError(null);
    try {
      const r = (await api.invoke('engine:abort', { sessionId })) as { ok: boolean };
      if (!r.ok) {
        setAbortError(t('chat.abort.notRunning'));
      }
      // 成功：状态经 session:status 推送恢复，无需额外处理。
    } catch (e) {
      setAbortError(e instanceof Error ? e.message : String(e));
    } finally {
      setAborting(false);
    }
  };

  const send = async (finalText: string): Promise<void> => {
    if (!finalText.trim() || !state.activeSessionId) return;
    // 模型保护：未选中模型（初始竞态）或未配置任何 Provider 时明确提示，
    // 而不是静默用默认模型（deepseek-chat）跑空。
    if (providers.length === 0) {
      setAbortError(t('chat.send.noProvider'));
      return;
    }
    const sep = model.indexOf('::');
    const modelName = sep >= 0 ? model.slice(sep + 2) : model;
    if (!modelName) {
      setAbortError(t('chat.send.noModel'));
      return;
    }
    setInput('');
    setAttachments([]);
    // 把选中的模型传给引擎：复合值 `providerId::本地模型名`（映射接入时为本地名，
    // 主进程 registry 已按本地名注册；自动路由时为 provider id）。
    const overrides: Record<string, unknown> = { models: { executor: modelName } };

    let text = finalText;
    // 计划模式：指令前缀 + 只读策略 + 只读工具白名单（双保险）。
    if (planMode) {
      text = `[计划模式] 请先阅读相关文件并制定详细实施计划（步骤、涉及文件、风险），不要执行任何修改操作；把计划列出来等用户确认后再执行。\n\n${text}`;
      overrides.policy = { mode: 'readonly', rules: [] };
      overrides.enabledTools = PLAN_MODE_TOOLS;
    }
    // 勾选的技能：注入技能元信息（SKILL.md 全文由引擎 read_file 读取）。
    const activeSkills = skills.filter((s) => selectedSkills.includes(s.id));
    if (activeSkills.length > 0) {
      const lines = activeSkills.map(
        (s) =>
          `- ${s.name}：${s.description}${s.source ? `（定义文件 ${s.source}，执行前请先 read_file 阅读全文并遵循其中指令）` : ''}`,
      );
      text += `\n\n[已启用技能]\n${lines.join('\n')}`;
    }
    // 勾选的 MCP 服务：信息性指示（引擎侧 MCP 工具接入后续版本生效）。
    const activeMcp = mcpServers.filter((m) => selectedMcp.includes(m.id));
    if (activeMcp.length > 0) {
      text += `\n\n[已启用 MCP 服务] ${activeMcp.map((m) => m.id).join(', ')}`;
    }
    await api.invoke('run:start', { sessionId: state.activeSessionId, text, overrides });
  };

  /**
   * 输入栏"截图"（仅浏览器面板打开时显示）：
   * 优先截取浏览器面板当前页面（agent 所见即用户所见）；失败可见，不静默吞掉。
   */
  const captureAndAnnotate = async (): Promise<void> => {
    setCaptureError(null);
    // 浏览器面板截图：webview.capturePage（渲染进程内，无需主进程）。
    if (browserCaptureRef.current) {
      try {
        const shot = await browserCaptureRef.current();
        if (shot) {
          setAnnotation({ base64: shot.base64, width: shot.width, height: shot.height });
          return;
        }
        setCaptureError(t('chat.screenshot.failed'));
        return;
      } catch (e) {
        setCaptureError(e instanceof Error ? e.message : t('chat.screenshot.failed'));
        return;
      }
    }
    // 兜底：主进程整屏捕获（browser:capture → desktopCapturer）。
    try {
      const r = (await api.invoke('browser:capture', {})) as {
        base64?: string;
        width?: number;
        height?: number;
        error?: string;
      };
      if (r.base64) {
        setAnnotation({ base64: r.base64, width: r.width || 1200, height: r.height || 800 });
        return;
      }
      setCaptureError(r.error ?? t('chat.screenshot.failed'));
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : t('chat.screenshot.failed'));
    }
  };

  const onAnnotationConfirm = async (b64: string): Promise<void> => {
    const result = (await api.invoke('browser:saveAnnotated', {
      base64: b64,
      sessionId: state.activeSessionId,
    })) as { ok: boolean; contentId: string };
    if (result.ok)
      setAttachments((prev) => [
        ...prev,
        { contentId: result.contentId, base64: b64, thumbnail: `data:image/png;base64,${b64}` },
      ]);
    setAnnotation(null);
  };

  const headerTabs: Array<{ key: NavTab; label: string }> = [
    { key: 'chat', label: t('tab.chat') },
    { key: 'subagents', label: t('tab.subagents') },
    { key: 'dashboard', label: t('tab.dashboard') },
    { key: 'settings', label: t('tab.settings') },
  ];
  const showHeaderTabs =
    nav === 'chat' || nav === 'subagents' || nav === 'dashboard' || nav === 'settings';

  const themes: Array<{ key: Theme; label: string; icon: string }> = [
    { key: 'dark', label: t('theme.dark'), icon: '🌙' },
    { key: 'light', label: t('theme.light'), icon: '☀️' },
    { key: 'contrast', label: t('theme.contrast'), icon: '◯' },
  ];

  // 模型下拉数据（自定义 Select，按提供商分组）：先看提供商，再选该提供商提供的模型。
  // 自动路由 provider 显示「网关自动路由」而非空模型名。
  const modelSelectOptions: SelectOption[] =
    providers.length > 0
      ? providers.flatMap((p) =>
          (p.models ?? [p.model]).map((m) => ({
            value: `${p.id}::${m}`,
            label: p.autoRoute ? t('chat.model.autoRoute') : m,
            // 分组标题 = 提供商 id；触发器显示「提供商 — 模型」。
            group: p.id,
          })),
        )
      : FALLBACK_MODELS.map((m) => ({ value: m.id, label: m.label }));

  return (
    <div className="app">
      <Sidebar
        sessions={state.sessions}
        {...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {})}
        activeNav={nav}
        onNavChange={setNav}
        onSelect={(id) => {
          void api.invoke('session:resume', { sessionId: id });
          store.setActive(id);
          setNav('chat');
        }}
        onNew={() => void newSession()}
        onDelete={(id) => void api.invoke('session:delete', { sessionId: id }).then(refresh)}
        onFork={(id) => void api.invoke('session:fork', { sessionId: id }).then(refresh)}
      />

      <main className="main">
        <header className="header">
          {showHeaderTabs
            ? headerTabs.map((tb) => (
                <button
                  key={tb.key}
                  className={`tab ${nav === tb.key ? 'active' : ''}`}
                  onClick={() => setNav(tb.key)}
                >
                  {tb.label}
                </button>
              ))
            : null}
          <div className="header-right">
            {/* 模型选择器（常驻 header，始终可切换）：展平 provider × models，自定义下拉 */}
            <div className="model-selector">
              <Select
                alignRight
                style={{ minWidth: 200, maxWidth: 320 }}
                value={model}
                placeholder={t('chat.model.placeholder')}
                options={modelSelectOptions}
                onChange={(v) => setModel(v)}
              />
            </div>
            {/* Language switcher */}
            <button
              className="switcher-btn"
              onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
              title={t('lang.toggle')}
            >
              {locale === 'zh' ? 'EN' : '中'}
            </button>
            {/* Theme dropdown */}
            <div className="theme-dropdown">
              <button
                className="switcher-btn"
                onClick={() => setShowThemeMenu(!showThemeMenu)}
                title={t('theme.toggle')}
              >
                {themes.find((th) => th.key === theme)?.icon}{' '}
                {themes.find((th) => th.key === theme)?.label}
              </button>
              {showThemeMenu ? (
                <div className="theme-dropdown-menu">
                  {themes.map((th) => (
                    <div
                      key={th.key}
                      className={`theme-dropdown-item ${theme === th.key ? 'active' : ''}`}
                      onClick={() => {
                        setTheme(th.key);
                        setShowThemeMenu(false);
                      }}
                    >
                      <span className={`theme-dot ${th.key}`} />
                      {th.icon} {th.label}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="status-chip">
              <span className={`status-dot ${activeView?.state ?? 'idle'}`} />
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
            <button type="button" className="breadcrumb-home" onClick={() => setNav('chat')}>
              {t('session.breadcrumb.home')}
            </button>
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
            browserOpen ? (
              <div className="chat-split">
                <div className="chat-split-main">
                  <SessionView
                    view={activeView}
                    onResolveApproval={(callId, decision, opts) => {
                      void api.invoke('approval:resolve', {
                        sessionId: state.activeSessionId,
                        callId,
                        decision,
                        ...(opts?.onceForSession ? { onceForSession: true } : {}),
                      });
                    }}
                  />
                </div>
                <BrowserPanel
                  api={api}
                  sessionId={state.activeSessionId!}
                  onClose={() =>
                    setBrowserSessions((prev) => ({ ...prev, [state.activeSessionId!]: false }))
                  }
                  captureRef={browserCaptureRef}
                />
              </div>
            ) : (
              <SessionView
                view={activeView}
                onResolveApproval={(callId, decision, opts) => {
                  void api.invoke('approval:resolve', {
                    sessionId: state.activeSessionId,
                    callId,
                    decision,
                    ...(opts?.onceForSession ? { onceForSession: true } : {}),
                  });
                }}
              />
            )
          ) : null}
          {nav === 'chat' && !activeView ? (
            <div className="empty-state">
              <div className="empty-state-icon">💬</div>
              <div className="empty-state-text">{t('session.empty.title')}</div>
              <div className="empty-state-hint">{t('session.empty.hint')}</div>
            </div>
          ) : null}
          {nav === 'subagents' && state.activeSessionId ? (
            <SubAgentPanel
              parentSessionId={state.activeSessionId}
              nodes={activeView?.subagents ?? []}
              loadSubSession={async (sid) =>
                ((await api.invoke('session:resume', {
                  sessionId: sid,
                })) as unknown as AgentEvent[]) ?? []
              }
            />
          ) : null}
          {nav === 'subagents' && !state.activeSessionId ? (
            <div className="empty-state">
              <div className="empty-state-icon">🤖</div>
              <div className="empty-state-text">{t('subagent.empty.title')}</div>
            </div>
          ) : null}
          {nav === 'skills' ? (
            <SkillPanel
              skills={panelSkills}
              onToggle={(id) =>
                setPanelSkills((p) =>
                  p.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
                )
              }
              onImport={(fp) => {
                const n =
                  fp
                    .split(/[\\/]/)
                    .pop()
                    ?.replace(/\.json$/, '') ?? 'imported';
                setPanelSkills((p) => [
                  ...p,
                  {
                    id: `imp-${Date.now().toString(36)}`,
                    name: n,
                    description: `从 ${fp} 导入`,
                    triggers: [n],
                    category: 'imported',
                    enabled: true,
                    source: fp,
                    icon: '📥',
                  },
                ]);
              }}
              onImportJson={(j) => {
                const d = JSON.parse(j);
                setPanelSkills((p) => [
                  ...p,
                  {
                    id: `imp-${Date.now().toString(36)}`,
                    name: d.name ?? 'unnamed',
                    description: d.description ?? '',
                    triggers: d.triggers ?? [],
                    category: 'imported',
                    enabled: true,
                    source: 'json',
                    icon: d.icon ?? '🧩',
                    version: d.version,
                  },
                ]);
              }}
              onDelete={(id) => setPanelSkills((p) => p.filter((s) => s.id !== id))}
            />
          ) : null}
          {nav === 'pulls' ? <PullRequestPanel prs={prs} /> : null}
          {nav === 'schedule' ? (
            <SchedulePanel
              tasks={schedules}
              runningIds={scheduleRunningIds}
              onCreate={async (req) => {
                const r = (await api.invoke('schedule:create', req)) as {
                  ok: boolean;
                  error?: string;
                };
                if (r.ok) await refreshSchedules();
                return r;
              }}
              onToggle={(id) =>
                void api.invoke('schedule:toggle', { id }).then(() => refreshSchedules())
              }
              onDelete={(id) =>
                void api.invoke('schedule:delete', { id }).then(() => refreshSchedules())
              }
              onRunNow={(id) => {
                setScheduleRunningIds((p) => [...p, id]);
                void api
                  .invoke('schedule:runNow', { id })
                  .then(() => refreshSchedules())
                  .finally(() => setScheduleRunningIds((p) => p.filter((x) => x !== id)));
              }}
              onPickWorkspace={async () => {
                const r = (await api.invoke('workspace:pick', {})) as {
                  ok: boolean;
                  path?: string;
                  canceled?: boolean;
                };
                return r.ok && !r.canceled && r.path ? r.path : null;
              }}
            />
          ) : null}
          {nav === 'plugins' ? (
            <PluginPanel
              mcpServers={mcpServers}
              onMcpRestart={(id) => void api.invoke('mcp:restart', { id }).then(refresh)}
              onMcpRemove={(id) => void api.invoke('mcp:remove', { id }).then(refresh)}
              onMcpAdd={async (req) => {
                const r = (await api.invoke('mcp:add', req)) as { ok: boolean; error?: string };
                void refresh();
                return r;
              }}
            />
          ) : null}
          {nav === 'security' ? (
            <SecurityPanel
              sandboxLevel={sandboxLevel}
              policyMode={policyMode}
              approvalStats={stats.approvals}
              onSetSandboxLevel={(lvl) => {
                setSandboxLevel(lvl);
                void api.invoke('config:set', { patch: { sandboxLevel: lvl } });
              }}
            />
          ) : null}
          {nav === 'dashboard' ? <Dashboard stats={stats} /> : null}
          {nav === 'settings' ? (
            <SettingsPanel
              providers={providers}
              policyMode={policyMode}
              policyRules={policyRules}
              mcpServers={mcpServers}
              sandboxLevel={sandboxLevel}
              costLimits={costLimits}
              closeBehavior={closeBehavior}
              onSetCloseBehavior={(b) => {
                setCloseBehavior(b);
                void api.invoke('config:set', { patch: { closeBehavior: b } });
              }}
              onSetProviderKey={(id, secret) =>
                void api
                  .invoke('config:set', { patch: { pendingKey: { id, secret } } })
                  .then(refresh)
              }
              onTestProvider={async (id) =>
                (await api.invoke('config:testProvider', { providerId: id })) as {
                  ok: boolean;
                  latencyMs?: number;
                  error?: string;
                }
              }
              onAddProvider={async (req) => {
                const r = (await api.invoke('provider:add', req)) as {
                  ok: boolean;
                  error?: string;
                };
                void refresh();
                return r;
              }}
              onRemoveProvider={(id) => void api.invoke('provider:remove', { id }).then(refresh)}
              onUpdateProvider={async (req) => {
                const r = (await api.invoke('provider:update', req)) as {
                  ok: boolean;
                  error?: string;
                };
                void refresh();
                return r;
              }}
              onFetchModels={async (req) =>
                (await api.invoke('provider:models', req)) as {
                  ok: boolean;
                  models?: string[];
                  error?: string;
                }
              }
              onSetPolicyMode={(m) => {
                setPolicyMode(m);
                void api.invoke('config:set', { patch: { policyMode: m } });
              }}
              onSetPolicyRules={(r) => {
                setPolicyRules(r);
                void api.invoke('config:set', { patch: { policyRules: r } });
              }}
              onSetSandboxLevel={(l) => {
                setSandboxLevel(l);
                void api.invoke('config:set', { patch: { sandboxLevel: l } });
              }}
              onSetCostLimits={(lim) => {
                setCostLimits(lim);
                void api.invoke('config:set', { patch: { costLimits: lim } });
              }}
              onMcpAdd={async (req) => {
                const r = (await api.invoke('mcp:add', req)) as { ok: boolean; error?: string };
                void refresh();
                return r;
              }}
              onMcpRemove={(id) => void api.invoke('mcp:remove', { id }).then(refresh)}
              onMcpRestart={(id) => void api.invoke('mcp:restart', { id }).then(refresh)}
              onMcpGetConfig={async () =>
                (await api.invoke('mcp:getConfig', {})) as {
                  ok: boolean;
                  servers?: McpAddRequest[];
                  error?: string;
                }
              }
              onMcpSetConfig={async (servers) => {
                const r = (await api.invoke('mcp:setConfig', { servers })) as {
                  ok: boolean;
                  errors?: Array<{ index: number; error: string }>;
                  error?: string;
                };
                void refresh();
                return r;
              }}
            />
          ) : null}
        </div>

        {nav === 'chat' && activeView ? (
          <InputBar
            api={api}
            sessionId={state.activeSessionId!}
            workspaceRoot={activeSession?.workspace}
            workspaceLabel={activeSession?.project}
            workspaceUnset={unsetWorkspaceIds.has(state.activeSessionId ?? '')}
            onPickWorkspace={() => void pickWorkspaceForSession()}
            input={input}
            setInput={setInput}
            send={(finalText) => void send(finalText)}
            aborting={aborting}
            canAbort={activeView?.state === 'running' || activeView?.state === 'pending_approval'}
            abort={() => void abortRun()}
            attachments={attachments}
            removeAttachment={(contentId) =>
              setAttachments((p) => p.filter((x) => x.contentId !== contentId))
            }
            captureAndAnnotate={() => void captureAndAnnotate()}
            captureError={captureError}
            dismissCaptureError={() => setCaptureError(null)}
            abortError={abortError}
            dismissAbortError={() => setAbortError(null)}
            policyMode={policyMode}
            onPolicyModeChange={(m) => {
              setPolicyMode(m);
              void api.invoke('config:set', { patch: { policyMode: m } });
            }}
            planMode={planMode}
            onPlanModeChange={setPlanMode}
            browserOpen={browserOpen}
            onToggleBrowser={toggleBrowser}
            skills={skills}
            selectedSkills={selectedSkills}
            onToggleSkill={(id) =>
              setSelectedSkills((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            mcpServers={mcpServers}
            selectedMcp={selectedMcp}
            onToggleMcp={(id) =>
              setSelectedMcp((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
          />
        ) : null}

        {annotation ? (
          <AnnotationOverlay
            screenshotBase64={annotation.base64}
            width={annotation.width}
            height={annotation.height}
            onConfirm={(b) => void onAnnotationConfirm(b)}
            onCancel={() => setAnnotation(null)}
          />
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

export function createClient(api: MoziApi): LoopbackChannel {
  const bus = new LoopbackChannel();
  void api;
  return bus;
}
