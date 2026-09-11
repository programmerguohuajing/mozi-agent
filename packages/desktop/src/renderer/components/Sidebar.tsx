/**
 * 会话侧栏（M10 §10.5①）：会话列表（时间 / 项目名 / 状态徽标 / token 消耗）+ 新建会话。
 */
import * as React from 'react';
import type { SessionSummary, SessionState } from '@mozi/protocol';

const STATE_BADGE: Record<SessionState, { label: string; cls: string }> = {
  idle: { label: '空闲', cls: 'bg-neutral-700 text-neutral-300' },
  running: { label: 'running', cls: 'bg-emerald-700 text-emerald-100' },
  pending_approval: { label: '待审批', cls: 'bg-amber-600 text-amber-50' },
  completed: { label: '已完成', cls: 'bg-sky-700 text-sky-100' },
  failed: { label: '失败', cls: 'bg-red-700 text-red-100' },
};

export interface SidebarProps {
  sessions: SessionSummary[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onFork: (sessionId: string) => void;
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-700">
      <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
        <span className="font-medium">墨子 Mozi</span>
        <button
          className="rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-500"
          onClick={props.onNew}
        >
          新建
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {props.sessions.map((s) => {
          const badge = STATE_BADGE[s.state];
          const active = s.id === props.activeSessionId;
          return (
            <li
              key={s.id}
              className={`cursor-pointer border-b border-neutral-800 px-3 py-2 text-sm hover:bg-neutral-800/50 ${
                active ? 'bg-neutral-800' : ''
              }`}
              onClick={() => props.onSelect(s.id)}
            >
              <div className="flex items-center gap-2">
                <span className="truncate">{s.project ?? s.id}</span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                <span>{s.updatedAt?.slice(0, 16).replace('T', ' ') ?? '-'}</span>
                {s.usage ? <span>{s.usage.totalTokens} tok</span> : null}
                <button
                  className="ml-auto hover:text-neutral-300"
                  title="分叉"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onFork(s.id);
                  }}
                >
                  ⑂
                </button>
                <button
                  className="hover:text-red-400"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(s.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
        {props.sessions.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-neutral-600">（无会话）</li>
        ) : null}
      </ul>
    </aside>
  );
}
