/**
 * 子智能体面板（M10 §10.5⑥ / M12 §12.11）。
 *
 * 会话树视图（主任务 → 各 sub，实时进度环）；点击子节点加载该子会话完整对话
 * （重放 subs/<id>/events.jsonl）；审批冒泡卡复用普通审批组件 + [子智能体 type] 徽标。
 */
import * as React from 'react';
import type { AgentEvent } from '@mozi/shared';
import type { SubAgentNode } from '../../shared/store.js';
import { eventToRenderItems, type RenderItem } from '../../shared/render-item.js';

export interface SubAgentPanelProps {
  /** 父会话 id。 */
  parentSessionId: string;
  nodes: SubAgentNode[];
  /** 加载某子会话的事件流（重放 subs/<id>/events.jsonl）。 */
  loadSubSession: (subSessionId: string) => Promise<AgentEvent[]>;
}

/** 进度环（纯 SVG）。 */
function ProgressRing({ step, max }: { step?: number; max?: number }): React.ReactElement {
  const ratio = step != null && max ? Math.min(1, step / max) : 0;
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width={20} height={20} viewBox="0 0 20 20">
      <circle cx={10} cy={10} r={r} fill="none" strokeWidth={2} className="stroke-neutral-700" />
      <circle
        cx={10}
        cy={10}
        r={r}
        fill="none"
        strokeWidth={2}
        className="stroke-violet-400"
        strokeDasharray={`${c * ratio} ${c}`}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

export function SubAgentPanel(props: SubAgentPanelProps): React.ReactElement {
  const [openSub, setOpenSub] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<RenderItem[]>([]);

  const open = async (subSessionId: string): Promise<void> => {
    setOpenSub(subSessionId);
    const events = await props.loadSubSession(subSessionId);
    setItems(events.flatMap((e) => eventToRenderItems(e)));
  };

  return (
    <div className="flex h-full">
      <div className="w-72 shrink-0 overflow-auto border-r border-neutral-700 p-2 text-sm">
        <div className="mb-2 text-xs text-neutral-400">会话树 · {props.parentSessionId}</div>
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span>◉ 主任务</span>
        </div>
        <ul className="ml-2 space-y-1 border-l border-neutral-800 pl-2">
          {props.nodes.map((n) => (
            <li
              key={n.subSessionId}
              className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-neutral-800/60 ${
                openSub === n.subSessionId ? 'bg-neutral-800' : ''
              }`}
              onClick={() => void open(n.subSessionId)}
            >
              <ProgressRing {...(n.step != null ? { step: n.step } : {})} {...(n.maxSteps != null ? { max: n.maxSteps } : {})} />
              <span className="truncate">{n.subSessionId.split('/').pop()}</span>
              <span className="rounded bg-violet-600/30 px-1 text-[10px] text-violet-200">{n.agentType}</span>
              <span
                className={
                  n.state === 'completed'
                    ? 'text-emerald-400'
                    : n.state === 'failed'
                      ? 'text-red-400'
                      : 'text-amber-400'
                }
              >
                {n.state}
              </span>
            </li>
          ))}
          {props.nodes.length === 0 ? <li className="text-neutral-600">（无子智能体）</li> : null}
        </ul>
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-3 text-sm">
        {openSub ? (
          <>
            <div className="mb-2 font-mono text-xs text-neutral-400">{openSub}</div>
            {items.map((it, i) => (
              <div key={`${it.id}-${i}`} className="my-1">
                {it.kind === 'assistant' ? (
                  <div className="whitespace-pre-wrap">{it.text}</div>
                ) : it.kind === 'tool' ? (
                  <div className="rounded border border-neutral-700 px-2 py-1 text-xs">
                    {it.state === 'error' ? '✗' : '✓'} <span className="font-mono">{it.name || it.callId}</span>
                    {it.summary ? <div className="mt-1 text-neutral-400">{it.summary}</div> : null}
                  </div>
                ) : it.kind === 'user' ? (
                  <div className="rounded bg-neutral-800/60 p-2 text-xs">{it.text}</div>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <div className="text-xs text-neutral-600">点击左侧子智能体节点加载其完整对话（重放 events.jsonl）。</div>
        )}
      </div>
    </div>
  );
}
