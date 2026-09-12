/**
 * TokenCounter — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import type { TokenUsage } from '@mozi/shared';

export interface TokenCounterProps {
  usage?: TokenUsage;
  running?: boolean;
  costLimitUsd?: number;
}

export function TokenCounter(props: TokenCounterProps): React.ReactElement | null {
  const { usage, running, costLimitUsd } = props;
  if (!usage) {
    return running ? (
      <span className="token-display">
        <span className="status-dot running"></span>
        <span>运行中…</span>
      </span>
    ) : null;
  }

  const fmt = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

  const cost = usage.costUsd ?? 0;
  const showCostBar = costLimitUsd !== undefined && costLimitUsd > 0 && cost > 0;
  const costPercent = showCostBar ? Math.min(100, (cost / costLimitUsd!) * 100) : 0;
  const overLimit = showCostBar && cost >= costLimitUsd!;
  const barColor = overLimit ? 'var(--danger)' : costPercent >= 80 ? 'var(--warning)' : 'var(--success)';

  return (
    <span className="token-display">
      {running ? <span className="status-dot running"></span> : null}
      <span className="arrow-up" title={`input tokens: ${usage.inputTokens}`}>↑{fmt(usage.inputTokens)}</span>
      <span className="arrow-down" title={`output tokens: ${usage.outputTokens}`}>↓{fmt(usage.outputTokens)}</span>
      {usage.totalTokens > 0 ? <span title="total tokens">Σ{fmt(usage.totalTokens)}</span> : null}
      {cost > 0 ? (
        <span
          className={`cost ${overLimit ? '' : ''}`}
          style={overLimit ? { fontWeight: 600, color: 'var(--danger)' } : showCostBar && costPercent >= 80 ? { color: 'var(--warning)' } : {}}
          title={`cost: $${cost.toFixed(4)} / limit: $${(costLimitUsd ?? 0).toFixed(4)}`}
        >
          ${cost.toFixed(cost < 0.01 ? 4 : 2)}
        </span>
      ) : null}
      {showCostBar ? (
        <span className="cost-bar" title={`成本 ${costPercent.toFixed(0)}%`}>
          <span className="cost-bar-fill" style={{ width: `${Math.max(2, costPercent)}%`, background: barColor }} />
        </span>
      ) : null}
    </span>
  );
}
