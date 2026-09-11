/**
 * 审批卡组件（M10 §10.5②）——与 CLI 同结构 + Monaco diff 预览 + 逐 hunk 批准。
 *
 * 复用同一 `ApprovalTicketView` 语义（M12 §12.7）：子智能体审批仅多 `agentType` 徽标。
 * 本文件为 React TSX（渲染进程）；样式类名遵循 Tailwind 约定。
 */
import * as React from 'react';
import type { DiffHunkView } from '../../shared/diff-types.js';

export interface ApprovalCardProps {
  agentType?: string;
  toolName: string;
  /** 结构化审批理由（与 shared ApprovalReason 同构）。 */
  reason:
    | { kind: 'policy'; ruleId: string; detail: string }
    | { kind: 'risk'; segments: Array<{ text: string; risk: string; color: 'green' | 'yellow' | 'red'; matchedRule?: string }> }
    | { kind: 'manual'; note: string };
  /** 若为文件修改：diff 模型（逐 hunk 批准）。 */
  diff?: { file: string; hunks: DiffHunkView[] };
  onResolve: (decision: 'allow' | 'deny', opts?: { hunkIds?: string[]; onceForSession?: boolean }) => void;
}

/** 风险分段渲染（red/yellow/green 标记 + matchedRule）。 */
function RiskSegments({ segments }: { segments: Extract<ApprovalCardProps['reason'], { kind: 'risk' }>['segments'] }): React.ReactElement {
  return (
    <ul className="mt-2 space-y-1 font-mono text-xs">
      {segments.map((seg, i) => {
        const mark = seg.color === 'red' ? '✗' : seg.color === 'yellow' ? '⚠' : '·';
        const cls =
          seg.color === 'red'
            ? 'text-red-500'
            : seg.color === 'yellow'
              ? 'text-amber-500'
              : 'text-neutral-400';
        return (
          <li key={i} className={cls}>
            {mark} [{seg.risk}] {seg.text}
            {seg.matchedRule ? <span className="ml-1 opacity-60">({seg.matchedRule})</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ApprovalCard(props: ApprovalCardProps): React.ReactElement {
  const [selectedHunks, setSelectedHunks] = React.useState<Set<string>>(new Set());
  const [onceForSession, setOnce] = React.useState(false);
  const hunks = props.diff?.hunks ?? [];

  const toggle = (id: string): void => {
    setSelectedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-amber-600/40 bg-amber-950/20 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-amber-400">⚠</span>
        {props.agentType ? (
          <span className="rounded bg-violet-600/30 px-1.5 py-0.5 text-xs text-violet-200">
            子智能体 {props.agentType}
          </span>
        ) : null}
        <span className="font-medium">需要批准：{props.toolName}</span>
      </div>

      {props.reason.kind === 'risk' ? <RiskSegments segments={props.reason.segments} /> : null}
      {props.reason.kind === 'policy' ? (
        <p className="mt-2 text-xs text-neutral-400">
          {props.reason.detail} <span className="opacity-60">[{props.reason.ruleId}]</span>
        </p>
      ) : null}
      {props.reason.kind === 'manual' ? (
        <p className="mt-2 text-xs text-neutral-400">{props.reason.note}</p>
      ) : null}

      {hunks.length > 0 ? (
        <div className="mt-3 rounded border border-neutral-700">
          <div className="flex items-center justify-between border-b border-neutral-700 px-2 py-1 text-xs text-neutral-400">
            <span>Diff 审阅：{props.diff?.file}</span>
            <button
              className="underline hover:text-neutral-200"
              onClick={() =>
                setSelectedHunks(
                  selectedHunks.size === hunks.length ? new Set() : new Set(hunks.map((h) => h.id)),
                )
              }
            >
              {selectedHunks.size === hunks.length ? '全不选' : '全选'}
            </button>
          </div>
          <ul className="max-h-64 overflow-auto">
            {hunks.map((h) => (
              <li
                key={h.id}
                className="cursor-pointer border-b border-neutral-800 px-2 py-1 last:border-b-0 hover:bg-neutral-800/40"
                onClick={() => toggle(h.id)}
              >
                <div className="flex items-center gap-2 text-xs">
                  <input type="checkbox" readOnly checked={selectedHunks.has(h.id)} />
                  <span className="font-mono text-neutral-400">
                    {h.id} · {h.kind} · 旧 L{h.oldRange.startLine}-{h.oldRange.endLine} → 新 L
                    {h.newRange.startLine}-{h.newRange.endLine}
                  </span>
                </div>
                <pre className="mt-0.5 overflow-x-auto text-[11px] leading-tight">
                  {h.oldLines.map((l, i) => (
                    <div key={`o${i}`} className="text-red-400/80">
                      - {l}
                    </div>
                  ))}
                  {h.newLines.map((l, i) => (
                    <div key={`n${i}`} className="text-emerald-400/80">
                      + {l}
                    </div>
                  ))}
                </pre>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
          onClick={() =>
            props.onResolve('allow', {
              ...(hunks.length ? { hunkIds: [...selectedHunks] } : {}),
              onceForSession,
            })
          }
        >
          批准{hunks.length ? `（${selectedHunks.size} 个 hunk）` : ''}
        </button>
        <button
          className="rounded bg-neutral-700 px-3 py-1 text-neutral-200 hover:bg-neutral-600"
          onClick={() => props.onResolve('deny')}
        >
          拒绝
        </button>
        <label className="ml-auto flex items-center gap-1 text-xs text-neutral-400">
          <input type="checkbox" checked={onceForSession} onChange={(e) => setOnce(e.target.checked)} />
          本会话一律允许
        </label>
      </div>
    </div>
  );
}
