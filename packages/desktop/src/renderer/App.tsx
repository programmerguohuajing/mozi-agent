/**
 * 渲染进程根组件（M10 §10.2 / §10.5）。
 *
 * 布局：左侧会话侧栏 + 主区（会话视图 / Diff 审阅 / 子智能体面板 / 仪表盘 / 设置）。
 * 通过 `window.mozi`（preload 白名单 API）与主进程通信；用 `UiStore` 订阅引擎事件。
 */
import * as React from 'react';
import { LoopbackChannel } from '@mozi/protocol';
import type { McpServerInfo, ProviderSummary, SessionSummary } from '@mozi/protocol';
import type { PolicyMode, PolicyRule } from '@mozi/shared';
import { UiStore } from '../shared/store.js';
import { Sidebar } from './components/Sidebar.js';
import { SessionView } from './components/SessionView.js';
import { Dashboard } from './components/Dashboard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { SubAgentPanel } from './components/SubAgentPanel.js';
import { AnnotationOverlay } from './components/AnnotationOverlay.js';
import type { DashboardStats } from '@mozi/protocol';

/** preload 暴露的 API（window.mozi）。 */
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

export function createClient(api: MoziApi): LoopbackChannel {
  // 渲染侧客户端：把 window.mozi 的 channel 字符串映射为类型化 client 语义。
  // 这里复用 LoopbackChannel 作为「本地事件总线」形态，便于 React 订阅。
  const bus = new LoopbackChannel();
  void api;
  return bus;
}

type Tab = 'chat' | 'subagents' | 'dashboard' | 'settings';

export function App({ api }: { api: MoziApi }): React.ReactElement {
  const store = React.useMemo(() => new UiStore(), []);
  const [state, setState] = React.useState(store.getState());
  const [tab, setTab] = React.useState<Tab>('chat');
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [policyMode, setPolicyMode] = React.useState<PolicyMode>('auto');
  const [policyRules, setPolicyRules] = React.useState<PolicyRule[]>([]);
  const [mcpServers, setMcpServers] = React.useState<McpServerInfo[]>([]);
  const [sandboxLevel, setSandboxLevel] = React.useState<0 | 1 | 2 | 3>(1);
  const [costLimits, setCostLimits] = React.useState<{ perSessionUsd?: number; perDayUsd?: number }>({});
  const [stats, setStats] = React.useState<DashboardStats>({
    tokensByDay: [],
    toolCalls: [],
    approvals: { allow: 0, deny: 0 },
    costByModel: [],
  });
  const [input, setInput] = React.useState('');
  /** 标注附件：等待发送的标注截图。 */
  const [attachments, setAttachments] = React.useState<Array<{ contentId: string; base64: string; thumbnail: string }>>([]);
  /** 标注覆盖层状态。 */
  const [annotation, setAnnotation] = React.useState<{ base64: string; width: number; height: number } | null>(null);

  // 订阅 store
  React.useEffect(() => store.subscribe(setState), [store]);

  // 订阅 IPC 事件 + 首次拉取
  React.useEffect(() => {
    const offEvent = api.on('engine:event', (payload) => {
      const p = payload as { sessionId: string; event: never };
      store.apply(p.sessionId, p.event);
    });
    const offStatus = api.on('session:status', (payload) => {
      const p = payload as { sessionId: string; state: never };
      store.status(p.sessionId, p.state);
    });
    void refresh();
    return () => {
      offEvent();
      offStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async (): Promise<void> => {
    const sessions = (await api.invoke('session:list', {})) as SessionSummary[];
    store.setSessions(sessions);
    const cfg = (await api.invoke('config:get', {})) as {
      providers: ProviderSummary[];
      policyMode: PolicyMode;
      settings: Record<string, unknown>;
    };
    setProviders(cfg.providers);
    setPolicyMode(cfg.policyMode);
    setPolicyRules((cfg.settings.policyRules as PolicyRule[]) ?? []);
    setSandboxLevel((cfg.settings.sandboxLevel as 0 | 1 | 2 | 3) ?? 1);
    setCostLimits((cfg.settings.costLimits as { perSessionUsd?: number; perDayUsd?: number }) ?? {});
    setMcpServers((await api.invoke('mcp:list', {})) as McpServerInfo[]);
  };

  const activeView = state.activeSessionId ? state.views[state.activeSessionId] : undefined;

  const newSession = async (): Promise<void> => {
    const created = (await api.invoke('session:create', {
      workspaceRoot: (await promptWorkspace()) ?? '.',
    })) as SessionSummary;
    await refresh();
    store.setActive(created.id);
  };

  const send = async (): Promise<void> => {
    if (!input.trim() || !state.activeSessionId) return;
    const text = input;
    setInput('');
    // 构造消息文本（含附件标记）
    const attachmentInfo = attachments.length > 0
      ? `\n[附件 ${attachments.length} 张标注截图: ${attachments.map((a) => a.contentId).join(', ')}]`
      : '';
    setAttachments([]);
    await api.invoke('run:start', { sessionId: state.activeSessionId, text: text + attachmentInfo });
  };

  /** 从内置浏览器截图并打开标注覆盖层。 */
  const captureAndAnnotate = async (): Promise<void> => {
    const result = await api.invoke('browser:capture', {});
    const r = result as { contentId?: string; base64?: string; width?: number; height?: number; error?: string };
    if (r.error || !r.base64) {
      alert(`截图失败：${r.error ?? '未知错误'}`);
      return;
    }
    setAnnotation({ base64: r.base64, width: r.width ?? 1200, height: r.height ?? 800 });
  };

  /** 标注确认 → 保存到附件列表。 */
  const onAnnotationConfirm = async (annotatedBase64: string): Promise<void> => {
    const result = await api.invoke('browser:saveAnnotated', {
      base64: annotatedBase64,
      sessionId: state.activeSessionId,
    }) as { ok: boolean; contentId: string };
    if (result.ok) {
      const thumbnail = `data:image/png;base64,${annotatedBase64.slice(0, 1000)}`;
      setAttachments((prev) => [...prev, { contentId: result.contentId, base64: annotatedBase64, thumbnail }]);
    }
    setAnnotation(null);
  };

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-100">
      <Sidebar
        sessions={state.sessions}
        {...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {})}
        onSelect={(id) => {
          void api.invoke('session:resume', { sessionId: id });
          store.setActive(id);
        }}
        onNew={() => void newSession()}
        onDelete={(id) => void api.invoke('session:delete', { sessionId: id }).then(refresh)}
        onFork={(id) => void api.invoke('session:fork', { sessionId: id }).then(refresh)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-neutral-700 px-3 py-2 text-xs">
          {(['chat', 'subagents', 'dashboard', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`rounded px-2 py-0.5 ${tab === t ? 'bg-neutral-700' : 'hover:bg-neutral-800'}`}
              onClick={() => {
                setTab(t);
                if (t === 'dashboard') {
                  void api.invoke('dashboard:stats', {}).then((s) => setStats(s as DashboardStats));
                }
              }}
            >
              {{ chat: '会话', subagents: '子智能体', dashboard: '仪表盘', settings: '设置' }[t]}
            </button>
          ))}
          <span className="ml-auto text-neutral-500">
            {activeView ? `状态：${activeView.state}` : '未选择会话'}
          </span>
        </header>

        <div className="min-h-0 flex-1">
          {tab === 'chat' && activeView ? (
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
          ) : null}
          {tab === 'chat' && !activeView ? (
            <div className="p-6 text-sm text-neutral-500">选择或新建一个会话开始。</div>
          ) : null}
          {tab === 'subagents' && state.activeSessionId ? (
            <SubAgentPanel
              parentSessionId={state.activeSessionId}
              nodes={activeView?.subagents ?? []}
              loadSubSession={async (subSessionId) => {
                const evs = (await api.invoke('session:resume', { sessionId: subSessionId })) as never;
                return (evs as unknown as import('@mozi/shared').AgentEvent[]) ?? [];
              }}
            />
          ) : null}
          {tab === 'dashboard' ? <Dashboard stats={stats} /> : null}
          {tab === 'settings' ? (
            <SettingsPanel
              providers={providers}
              policyMode={policyMode}
              policyRules={policyRules}
              mcpServers={mcpServers}
              sandboxLevel={sandboxLevel}
              costLimits={costLimits}
              onSetProviderKey={(id, secret) => {
                void api.invoke('config:set', { patch: { pendingKey: { id, secret } } }).then(refresh);
              }}
              onTestProvider={async (id) =>
                (await api.invoke('config:testProvider', { providerId: id })) as {
                  ok: boolean;
                  latencyMs?: number;
                  error?: string;
                }
              }
              onSetPolicyMode={(mode) => {
                setPolicyMode(mode);
                void api.invoke('config:set', { patch: { policyMode: mode } });
              }}
              onSetPolicyRules={(rules) => {
                setPolicyRules(rules);
                void api.invoke('config:set', { patch: { policyRules: rules } });
              }}
              onSetSandboxLevel={(lvl) => {
                setSandboxLevel(lvl);
                void api.invoke('config:set', { patch: { sandboxLevel: lvl } });
              }}
              onSetCostLimits={(limits) => {
                setCostLimits(limits);
                void api.invoke('config:set', { patch: { costLimits: limits } });
              }}
            />
          ) : null}
        </div>

        {tab === 'chat' && activeView ? (
          <div className="flex flex-col gap-1 border-t border-neutral-700 p-2">
            {/* 附件预览区 */}
            {attachments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div key={a.contentId} className="group relative">
                    <img
                      src={`data:image/png;base64,${a.base64}`}
                      className="h-16 w-24 rounded border border-neutral-600 object-cover"
                      alt="标注截图"
                    />
                    <button
                      className="absolute right-0 top-0 rounded-full bg-red-600 px-1 text-xs text-white opacity-0 group-hover:opacity-100"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.contentId !== a.contentId))}
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <textarea
                className="min-h-10 flex-1 resize-none rounded bg-neutral-800 px-2 py-1 text-sm"
                placeholder="输入任务…（Enter 发送，Shift+Enter 换行）"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                className="rounded bg-sky-700 px-3 text-sm text-white hover:bg-sky-600"
                onClick={() => void captureAndAnnotate()}
                title="从内置浏览器截图并标注"
              >
                截图标注
              </button>
              <button
                className="rounded bg-emerald-600 px-3 text-sm text-white hover:bg-emerald-500"
                onClick={() => void send()}
              >
                发送
              </button>
              <button
                className="rounded bg-neutral-700 px-3 text-sm hover:bg-neutral-600"
                onClick={() =>
                  void api.invoke('engine:abort', { sessionId: state.activeSessionId })
                }
              >
                中止
              </button>
            </div>
          </div>
        ) : null}

        {/* 标注覆盖层 */}
        {annotation ? (
          <AnnotationOverlay
            screenshotBase64={annotation.base64}
            width={annotation.width}
            height={annotation.height}
            onConfirm={(b64) => void onAnnotationConfirm(b64)}
            onCancel={() => setAnnotation(null)}
          />
        ) : null}
      </main>
    </div>
  );
}

/** 选择 workspace 目录（Electron 中经 dialog；此处退化 prompt）。 */
async function promptWorkspace(): Promise<string | null> {
  try {
    return globalThis.prompt?.('workspace 目录') ?? null;
  } catch {
    return null;
  }
}
