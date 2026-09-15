/**
 * 审批卡组件 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import type { DiffHunkView } from '../../shared/diff-types.js';

export interface ApprovalCardProps {
  agentType?: string;
  toolName: string;
  reason:
    | { kind: 'policy'; ruleId: string; detail: string }
    | {
        kind: 'risk';
        segments: Array<{
          text: string;
          risk: string;
          color: 'green' | 'yellow' | 'red';
          matchedRule?: string;
        }>;
      }
    | { kind: 'manual'; note: string };
  diff?: { file: string; hunks: DiffHunkView[] };
  onResolve: (
    decision: 'allow' | 'deny',
    opts?: { hunkIds?: string[]; onceForSession?: boolean },
  ) => void;
}

function RiskSegments({
  segments,
}: {
  segments: Extract<ApprovalCardProps['reason'], { kind: 'risk' }>['segments'];
}): React.ReactElement {
  return (
    <ul
      style={{ listStyle: 'none', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {segments.map((seg, i) => {
        const cls =
          seg.color === 'red' ? 'risk-red' : seg.color === 'yellow' ? 'risk-yellow' : 'risk-green';
        const mark = seg.color === 'red' ? '✗' : seg.color === 'yellow' ? '⚠' : '·';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 风险分段为静态渲染列表，无重排/复用，索引 key 稳定。
          <li key={i} className={`risk-segment ${cls}`}>
            {mark} [{seg.risk}] {seg.text}
            {seg.matchedRule ? (
              <span style={{ marginLeft: 4, opacity: 0.6 }}>({seg.matchedRule})</span>
            ) : null}
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
    <div className="approval-card">
      <div className="approval-header">
        <span className="approval-icon">⚠</span>
        {props.agentType ? <span className="agent-badge">子智能体 {props.agentType}</span> : null}
        <span className="approval-title">需要批准：{props.toolName}</span>
      </div>

      {props.reason.kind === 'risk' ? <RiskSegments segments={props.reason.segments} /> : null}
      {props.reason.kind === 'policy' ? (
        <div className="approval-body">
          {props.reason.detail} <span style={{ opacity: 0.6 }}>[{props.reason.ruleId}]</span>
        </div>
      ) : null}
      {props.reason.kind === 'manual' ? (
        <div className="approval-body">{props.reason.note}</div>
      ) : null}

      {hunks.length > 0 ? (
        <div
          style={{
            marginTop: 12,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--border-light)',
              padding: '6px 12px',
              fontSize: 12,
              color: 'var(--text-2)',
            }}
          >
            <span>Diff 审阅：{props.diff?.file}</span>
            <button
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--primary)',
                cursor: 'pointer',
                fontSize: 12,
                textDecoration: 'underline',
              }}
              onClick={() =>
                setSelectedHunks(
                  selectedHunks.size === hunks.length ? new Set() : new Set(hunks.map((h) => h.id)),
                )
              }
            >
              {selectedHunks.size === hunks.length ? '全不选' : '全选'}
            </button>
          </div>
          <ul style={{ maxHeight: 256, overflowY: 'auto', listStyle: 'none' }}>
            {hunks.map((h) => (
              <li
                key={h.id}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border-light)',
                  padding: '6px 12px',
                  fontSize: 12,
                }}
                onClick={() => toggle(h.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" readOnly checked={selectedHunks.has(h.id)} />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
                    {h.id} · {h.kind} · L{h.oldRange.startLine}-{h.oldRange.endLine} → L
                    {h.newRange.startLine}-{h.newRange.endLine}
                  </span>
                </div>
                <pre
                  style={{
                    marginTop: 4,
                    overflowX: 'auto',
                    fontSize: 11,
                    lineHeight: 1.4,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {h.oldLines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff 行静态展示，无重排，索引 key 稳定。
                    <div key={`o${i}`} style={{ color: 'var(--danger)', opacity: 0.8 }}>
                      - {l}
                    </div>
                  ))}
                  {h.newLines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff 行静态展示，无重排，索引 key 稳定。
                    <div key={`n${i}`} style={{ color: 'var(--success)', opacity: 0.8 }}>
                      + {l}
                    </div>
                  ))}
                </pre>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="approval-actions" style={{ marginTop: 12 }}>
        <button
          className="btn-approve"
          onClick={() =>
            props.onResolve('allow', {
              ...(hunks.length ? { hunkIds: [...selectedHunks] } : {}),
              onceForSession,
            })
          }
        >
          批准{hunks.length ? `（${selectedHunks.size} 个 hunk）` : ''}
        </button>
        <button className="btn-deny" onClick={() => props.onResolve('deny')}>
          拒绝
        </button>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={onceForSession}
            onChange={(e) => setOnce(e.target.checked)}
          />
          本会话一律允许
        </label>
      </div>
    </div>
  );
}
