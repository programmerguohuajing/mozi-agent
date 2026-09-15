import type { AgentEvent } from '@mozi/shared';
/**
 * 子智能体面板 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import { type RenderItem, eventToRenderItems } from '../../shared/render-item.js';
import type { SubAgentNode } from '../../shared/store.js';

export interface SubAgentPanelProps {
  parentSessionId: string;
  nodes: SubAgentNode[];
  loadSubSession: (subSessionId: string) => Promise<AgentEvent[]>;
}

function ProgressRing({ step, max }: { step?: number; max?: number }): React.ReactElement {
  const ratio = step != null && max ? Math.min(1, step / max) : 0;
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" role="img">
      <title>子代理进度</title>
      <circle cx={10} cy={10} r={r} fill="none" strokeWidth={2} stroke="var(--border)" />
      <circle
        cx={10}
        cy={10}
        r={r}
        fill="none"
        strokeWidth={2}
        stroke="var(--info)"
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
    <div className="subagent-view">
      <div className="subagent-tree">
        <div className="tree-title">会话树</div>
        <div className="tree-root">
          <span className="tree-root-icon">◉</span> 主任务
        </div>
        <div className="tree-children">
          {props.nodes.map((n) => (
            <div
              key={n.subSessionId}
              className={`tree-node ${openSub === n.subSessionId ? 'active' : ''}`}
              onClick={() => void open(n.subSessionId)}
            >
              <ProgressRing
                {...(n.step != null ? { step: n.step } : {})}
                {...(n.maxSteps != null ? { max: n.maxSteps } : {})}
              />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {n.subSessionId.split('/').pop()}
              </span>
              <span className="node-type">{n.agentType}</span>
              <span className={`node-state ${n.state}`}>
                {n.state === 'completed'
                  ? 'done'
                  : n.state === 'failed'
                    ? 'fail'
                    : n.step != null
                      ? `${n.step}/${n.maxSteps ?? ''}`
                      : n.state}
              </span>
            </div>
          ))}
          {props.nodes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>
              （无子智能体）
            </div>
          ) : null}
        </div>
      </div>
      <div className="subagent-detail">
        {openSub ? (
          <>
            <div className="detail-header">{openSub}</div>
            {items.map((it, i) => (
              <div key={`${it.id}-${i}`} style={{ marginBottom: 8 }}>
                {it.kind === 'assistant' ? (
                  <div className="msg msg-assistant" style={{ maxWidth: '100%' }}>
                    <div className="msg-label">● {openSub.split('/').pop()}</div>
                    <div className="msg-text">{it.text}</div>
                  </div>
                ) : it.kind === 'tool' ? (
                  <div className="tool-card">
                    <div className="tool-header">
                      <span className={`tool-icon ${it.state}`}>
                        {it.state === 'error' ? '✗' : it.state === 'done' ? '✓' : '◐'}
                      </span>
                      <span className="tool-name">{it.name || it.callId}</span>
                    </div>
                    {it.summary ? <div className="tool-summary">{it.summary}</div> : null}
                  </div>
                ) : it.kind === 'user' ? (
                  <div className="msg msg-user" style={{ maxWidth: '100%' }}>
                    <div className="msg-label">用户</div>
                    <div className="msg-text">{it.text}</div>
                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">🤖</div>
            <div className="empty-state-text">点击左侧子智能体节点加载其完整对话</div>
            <div className="empty-state-hint">重放 events.jsonl 事件流</div>
          </div>
        )}
      </div>
    </div>
  );
}
