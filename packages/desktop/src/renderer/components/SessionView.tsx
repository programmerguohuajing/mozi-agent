/**
 * 会话视图 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import type { RenderItem } from '../../shared/render-item.js';
import type { SessionView as SessionViewState, SubAgentNode } from '../../shared/store.js';
import type { MoziApi } from '../App.js';
import { useApp } from '../i18n.js';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard.js';
import { Lightbox } from './Lightbox.js';

export interface SessionViewProps {
  view: SessionViewState;
  contextBudget?: number;
  estimatedTokens?: number;
  dirtyFiles?: string[];
  /** IPC 通道（截图卡片经 image:read 加载本地图片放大查看）。 */
  api?: MoziApi;
  onResolveApproval: (
    callId: string,
    decision: 'allow' | 'deny',
    opts?: { hunkIds?: string[]; onceForSession?: boolean },
  ) => void;
  onOpenSubSession?: (subSessionId: string) => void;
}

/**
 * 工具产出的图片卡片（display.kind='image'，如 screenshot 保存的截图）：
 * 经 `image:read` 加载为缩略图，点击打开灯箱放大查看。
 */
function ToolImage({ api, path }: { api?: MoziApi; path: string }): React.ReactElement | null {
  const { t } = useApp();
  const [src, setSrc] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    if (!api) {
      setError(t('chat.image.unavailable'));
      return undefined;
    }
    void api
      .invoke('image:read', { path })
      .then((r) => {
        if (cancelled) return;
        const res = r as { ok: boolean; base64?: string; mime?: string; error?: string };
        if (res.ok && res.base64) {
          setSrc(`data:${res.mime ?? 'image/png'};base64,${res.base64}`);
        } else {
          setError(res.error ?? t('chat.image.loadFailed'));
        }
      })
      .catch(() => {
        if (!cancelled) setError(t('chat.image.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, path]);

  if (error) {
    return <div className="tool-image-error">🖼 {error}</div>;
  }
  if (!src) {
    return <div className="tool-image-loading">{t('chat.image.loading')}</div>;
  }
  return (
    <>
      <img
        className="tool-image"
        src={src}
        alt={path}
        title={t('chat.image.view')}
        onClick={() => setOpen(true)}
      />
      {open ? <Lightbox src={src} alt={path} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RenderRow({
  item,
  api,
}: {
  item: RenderItem;
  api?: MoziApi;
  key?: React.Key;
}): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="msg-label">用户</div>
          <div className="msg-text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="msg-label">● Mozi</div>
          <div className="msg-text">
            {item.text}
            {item.streaming ? <span className="msg-streaming">▌</span> : null}
          </div>
        </div>
      );
    case 'reasoning':
      return (
        <div className="reasoning-box">
          <div
            className="reasoning-header"
            onClick={(e) => {
              const el = e.currentTarget.nextElementSibling as HTMLElement;
              if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
            }}
          >
            <span>▶</span> 推理过程
          </div>
          <div className="reasoning-body" style={{ display: 'none' }}>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{item.text}</pre>
          </div>
        </div>
      );
    case 'tool':
      return (
        <div className="tool-card">
          <div className="tool-header">
            <span className={`tool-icon ${item.state}`}>
              {item.state === 'error'
                ? '✗'
                : item.state === 'done'
                  ? '✓'
                  : item.state === 'running'
                    ? '◐'
                    : '→'}
            </span>
            <span className="tool-name">{item.name || item.callId}</span>
            {item.durationMs != null ? (
              <span className="tool-duration">{item.durationMs}ms</span>
            ) : (
              <span className="tool-duration">{item.state === 'running' ? '...' : ''}</span>
            )}
          </div>
          {item.summary ? <div className="tool-summary">{item.summary}</div> : null}
          {item.display?.kind === 'image' ? (
            <ToolImage api={api} path={item.display.path} />
          ) : null}
        </div>
      );
    case 'compacted':
      return (
        <div className="compact-notice">
          <span>🗜</span> 上下文已压缩：移除 {item.removedTurns} 条，节省 ~{item.savedTokens} tokens
        </div>
      );
    case 'subagent':
      return (
        <div className="subagent-notice">
          ◐ 子智能体 {item.subSessionId.split('/').pop()} · {item.state}
          {item.currentTool ? ` · ${item.currentTool}` : ''}
          {item.summary ? <div style={{ marginTop: 4, opacity: 0.8 }}>{item.summary}</div> : null}
          {item.error ? (
            <div style={{ marginTop: 4, color: 'var(--danger)' }}>{item.error}</div>
          ) : null}
        </div>
      );
    case 'notice':
      return (
        <div className={item.level === 'error' ? 'notice-error' : 'notice-warn'}>{item.text}</div>
      );
    case 'usage':
      return (
        <div className="usage-row">
          in={item.usage.inputTokens} out={item.usage.outputTokens}
          {item.steps != null ? ` · ${item.steps} step(s)` : ''}
          {item.usage.costUsd ? ` · $${item.usage.costUsd.toFixed(4)}` : ''}
        </div>
      );
    case 'approval':
    case 'todo':
      return null;
    default:
      return null;
  }
}

function PlanPanel({
  tasks,
}: { tasks: Extract<RenderItem, { kind: 'todo' }>['tasks'] }): React.ReactElement {
  return (
    <div className="side-section">
      <div className="side-title">📋 计划</div>
      <ul className="plan-list">
        {tasks.length === 0 ? (
          <li style={{ fontSize: 13, color: 'var(--text-3)' }}>（无）</li>
        ) : null}
        {tasks.map((t) => (
          <li key={t.id} className="plan-item">
            <span
              className={`plan-icon ${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo'}`}
            >
              {t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className={`plan-text ${t.status === 'done' ? 'done' : ''}`}>{t.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContextPanel({
  budget,
  used,
  compacted,
  dirty,
  usage,
  model,
}: {
  budget?: number;
  used?: number;
  compacted: number;
  dirty: string[];
  /** 最近轮次用量（turn.completed 的 usage；侧栏次级信息）。 */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** 当前执行模型。 */
  model?: string;
}): React.ReactElement {
  const ratio = budget && used ? Math.min(1, used / budget) : 0;
  const cls = ratio > 0.8 ? 'danger' : ratio > 0.6 ? 'warn' : 'ok';
  const pct = Math.round(ratio * 100);
  return (
    <div className="side-section">
      <div className="side-title">📊 上下文</div>
      <div className="budget-bar">
        <div className={`budget-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="budget-text">
        {(used ?? 0).toLocaleString()} / {budget?.toLocaleString() ?? '?'} tokens · 压缩 {compacted}{' '}
        次
      </div>
      {/* 真实数据源：context.usage 事件（used）+ budgetFor（budget）。 */}
      <div className="context-stats">
        {usage ? (
          <div className="context-stat-row">
            <span className="context-stat-label">最近轮次</span>
            <span className="context-stat-value">
              in {usage.inputTokens.toLocaleString()} · out {usage.outputTokens.toLocaleString()}
            </span>
          </div>
        ) : null}
        {model ? (
          <div className="context-stat-row">
            <span className="context-stat-label">模型</span>
            <span className="context-stat-value" title={model}>
              {model}
            </span>
          </div>
        ) : null}
      </div>
      {dirty.length > 0 ? (
        <div className="dirty-warning">
          ⚠ {dirty.length} 个文件已被外部修改：{dirty.slice(0, 3).join(', ')}
          {dirty.length > 3 ? '…' : ''}
        </div>
      ) : null}
    </div>
  );
}

export function SessionView(props: SessionViewProps): React.ReactElement {
  const { view } = props;
  const todos = [...view.items].reverse().find((it) => it.kind === 'todo');
  const compacted = view.items.filter((it) => it.kind === 'compacted').length;
  const messagesRef = React.useRef<HTMLDivElement | null>(null);
  const shouldScrollRef = React.useRef(true);

  const scrollToBottom = (): void => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const onScroll = (): void => {
    const el = messagesRef.current;
    if (!el) return;
    const threshold = 50;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    shouldScrollRef.current = atBottom;
  };

  // 新消息到达或流式更新时：若用户本来在底部，则自动滚动到底部。
  React.useEffect(() => {
    if (shouldScrollRef.current) {
      scrollToBottom();
    }
    return undefined;
  }, [view.items]);

  // 初始挂载也滚到底部。
  React.useEffect(() => {
    scrollToBottom();
    return undefined;
  }, []);

  return (
    <div className="chat-view">
      <div className="chat-main">
        <div className="chat-messages" ref={messagesRef} onScroll={onScroll}>
          {view.items.map((item, i) => (
            <RenderRow
              key={item.id === 'update' ? `u-${i}` : `${item.id}-${i}`}
              item={item}
              api={props.api}
            />
          ))}
          {view.pendingApprovals.map((it) =>
            it.kind === 'approval' ? (
              <div key={it.id} className="approval-card">
                <ApprovalCard
                  {...(it.agentType ? { agentType: it.agentType } : {})}
                  toolName={it.call.name}
                  reason={it.reason as ApprovalCardProps['reason']}
                  onResolve={(decision, opts) => props.onResolveApproval(it.callId, decision, opts)}
                />
              </div>
            ) : null,
          )}
          {view.subagents.length > 0 ? (
            <div
              className="side-section"
              style={{
                border: '1px solid rgba(163,113,247,0.2)',
                borderRadius: 'var(--radius-sm)',
                padding: 12,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--info)', marginBottom: 6 }}>
                子智能体（{view.subagents.length}）
              </div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {view.subagents.map((s: SubAgentNode) => (
                  <li
                    key={s.subSessionId}
                    style={{
                      cursor: 'pointer',
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    onClick={() => props.onOpenSubSession?.(s.subSessionId)}
                  >
                    <span>{s.state === 'completed' ? '✔' : s.state === 'failed' ? '✗' : '◐'}</span>
                    <span>{s.subSessionId.split('/').pop()}</span>
                    <span className="node-type">{s.agentType}</span>
                    {s.step != null ? (
                      <span style={{ color: 'var(--text-3)' }}>
                        {s.step}
                        {s.maxSteps ? `/${s.maxSteps}` : ''}
                      </span>
                    ) : null}
                    {s.currentTool ? (
                      <span style={{ color: 'var(--text-3)' }}>· {s.currentTool}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <aside className="chat-side">
        <PlanPanel tasks={todos && todos.kind === 'todo' ? todos.tasks : []} />
        <ContextPanel
          // 真实数据源：context.usage 事件 → store（used/budget）。
          {...(view.contextBudget != null ? { budget: view.contextBudget } : {})}
          {...(view.contextUsed != null ? { used: view.contextUsed } : {})}
          compacted={compacted}
          dirty={props.dirtyFiles ?? []}
          {...(view.usage ? { usage: view.usage } : {})}
          {...(view.usage?.model ? { model: view.usage.model } : {})}
        />
      </aside>
    </div>
  );
}
