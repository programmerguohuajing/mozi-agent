/**
 * 会话视图（M10 §10.5②）——主界面。
 *
 * 组成：对话流（复用 M9 RenderItem 模型）+ 流式缓冲区（跟随模式）+
 * 审批卡 + 计划面板（todo_list 可视化）+ 上下文面板（预算条 / 压缩历史 / 文件新鲜度）。
 */
import * as React from 'react';
import type { RenderItem } from '../../shared/render-item.js';
import type { SessionView as SessionViewState, SubAgentNode } from '../../shared/store.js';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard.js';

export interface SessionViewProps {
  view: SessionViewState;
  /** 上下文预算（用于进度条）。 */
  contextBudget?: number;
  /** 估算 tokens（来自引擎 BuildView）。 */
  estimatedTokens?: number;
  /** 文件新鲜度提醒（脏文件相对路径）。 */
  dirtyFiles?: string[];
  onResolveApproval: (callId: string, decision: 'allow' | 'deny', opts?: { hunkIds?: string[]; onceForSession?: boolean }) => void;
  onOpenSubSession?: (subSessionId: string) => void;
}

/** 单条 RenderItem 渲染。 */
function RenderRow({ item }: { item: RenderItem; key?: React.Key }): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="my-2 rounded-lg bg-neutral-800/60 p-2">
          <div className="mb-1 text-xs text-neutral-500">你</div>
          <div className="whitespace-pre-wrap">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="my-2 whitespace-pre-wrap">
          {item.text}
          {item.streaming ? <span className="ml-1 animate-pulse">▌</span> : null}
        </div>
      );
    case 'reasoning':
      return (
        <details className="my-1 text-xs text-neutral-500">
          <summary className="cursor-pointer">推理过程</summary>
          <pre className="whitespace-pre-wrap">{item.text}</pre>
        </details>
      );
    case 'tool':
      return (
        <div className="my-1 rounded border border-neutral-700 px-2 py-1 text-xs">
          <span className="mr-2">
            {item.state === 'error' ? '✗' : item.state === 'done' ? '✓' : item.state === 'running' ? '◐' : '→'}
          </span>
          <span className="font-mono">{item.name || item.callId}</span>
          {item.summary ? <div className="mt-1 text-neutral-400">{item.summary}</div> : null}
        </div>
      );
    case 'compacted':
      return (
        <div className="my-1 rounded bg-sky-950/40 px-2 py-1 text-xs text-sky-300">
          🗜 上下文已压缩：移除 {item.removedTurns} 条，节省 ~{item.savedTokens} tokens
        </div>
      );
    case 'subagent':
      return (
        <div className="my-1 rounded bg-violet-950/30 px-2 py-1 text-xs text-violet-200">
          ◐ 子智能体 {item.subSessionId.split('/').pop()} · {item.state}
          {item.currentTool ? ` · ${item.currentTool}` : ''}
          {item.summary ? <div className="mt-1 text-violet-300/80">{item.summary}</div> : null}
          {item.error ? <div className="mt-1 text-red-300">{item.error}</div> : null}
        </div>
      );
    case 'notice':
      return (
        <div className={`my-1 text-xs ${item.level === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
          {item.text}
        </div>
      );
    case 'usage':
      return (
        <div className="my-1 text-right text-xs text-neutral-500">
          in={item.usage.inputTokens} out={item.usage.outputTokens}
          {item.steps != null ? ` · ${item.steps} step(s)` : ''}
        </div>
      );
    case 'approval':
    case 'todo':
      return null; // 单独区域渲染
    default:
      return null;
  }
}

/** 计划面板（todo_list 可视化，§10.5②）。 */
function PlanPanel({ tasks }: { tasks: Extract<RenderItem, { kind: 'todo' }>['tasks'] }): React.ReactElement {
  return (
    <div className="rounded border border-neutral-700 p-2 text-xs">
      <div className="mb-1 text-neutral-400">计划</div>
      {tasks.length === 0 ? (
        <div className="text-neutral-600">（无）</div>
      ) : (
        <ul className="space-y-0.5">
          {tasks.map((t) => (
            <li key={t.id}>
              {t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} {t.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 上下文面板（预算条 + 压缩历史 + 新鲜度，§10.5②）。 */
function ContextPanel({
  budget,
  used,
  compacted,
  dirty,
}: {
  budget?: number;
  used?: number;
  compacted: number;
  dirty: string[];
}): React.ReactElement {
  const ratio = budget && used ? Math.min(1, used / budget) : 0;
  return (
    <div className="rounded border border-neutral-700 p-2 text-xs">
      <div className="mb-1 text-neutral-400">上下文</div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-700">
        <div
          className={`h-full ${ratio > 0.8 ? 'bg-red-500' : 'bg-emerald-500'}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <div className="mt-1 text-neutral-500">
        {used ?? 0} / {budget ?? '?'} tokens · 压缩 {compacted} 次
      </div>
      {dirty.length ? (
        <div className="mt-1 text-amber-400">
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

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto p-3">
        {view.items.map((item, i) => (
          <RenderRow key={item.id === 'update' ? `u-${i}` : `${item.id}-${i}`} item={item} />
        ))}
        {view.pendingApprovals.map((it) =>
          it.kind === 'approval' ? (
            <div key={it.id} className="my-2">
              <ApprovalCard
                {...(it.agentType ? { agentType: it.agentType } : {})}
                toolName={it.call.name}
                reason={it.reason as ApprovalCardProps['reason']}
                onResolve={(decision, opts) => props.onResolveApproval(it.callId, decision, opts)}
              />
            </div>
          ) : null,
        )}
        {view.subagents.length ? (
          <div className="mt-3 rounded border border-violet-800/40 p-2">
            <div className="mb-1 text-xs text-violet-300">子智能体（{view.subagents.length}）</div>
            <ul className="space-y-1 text-xs">
              {view.subagents.map((s: SubAgentNode) => (
                <li
                  key={s.subSessionId}
                  className="cursor-pointer hover:text-violet-200"
                  onClick={() => props.onOpenSubSession?.(s.subSessionId)}
                >
                  {s.state === 'completed' ? '✔' : s.state === 'failed' ? '✗' : '◐'}{' '}
                  {s.subSessionId.split('/').pop()} [{s.agentType}]
                  {s.step != null ? ` · ${s.step}${s.maxSteps ? `/${s.maxSteps}` : ''}` : ''}
                  {s.currentTool ? ` · ${s.currentTool}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <aside className="w-64 shrink-0 space-y-2 overflow-auto border-l border-neutral-700 p-2">
        <PlanPanel tasks={todos && todos.kind === 'todo' ? todos.tasks : []} />
        <ContextPanel
          {...(props.contextBudget != null ? { budget: props.contextBudget } : {})}
          {...(props.estimatedTokens != null ? { used: props.estimatedTokens } : {})}
          compacted={compacted}
          dirty={props.dirtyFiles ?? []}
        />
      </aside>
    </div>
  );
}
