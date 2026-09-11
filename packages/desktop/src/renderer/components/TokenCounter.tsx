/**
 * TokenCounter：实时 token 用量计数器（App header 内嵌展示）。
 *
 * 数据源：SessionView.usage（store 由 token.usage / turn.completed 实时更新）。
 * 展示：in / out / total / cost + 运行中的呼吸灯。
 */
import * as React from 'react';
import type { TokenUsage } from '@mozi/shared';

export interface TokenCounterProps {
  usage?: TokenUsage;
  /** 当前会话是否运行中（呼吸灯）。 */
  running?: boolean;
  /** 成本上限（有值时显示成本进度条）。 */
  costLimitUsd?: number;
}

export function TokenCounter(props: TokenCounterProps): React.ReactElement | null {
  const { usage, running, costLimitUsd } = props;
  if (!usage) {
    return running ? (
      <span className="flex items-center gap-1 text-xs text-neutral-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        运行中…
      </span>
    ) : null;
  }

  const fmt = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

  const cost = usage.costUsd ?? 0;
  const showCostBar = costLimitUsd !== undefined && costLimitUsd > 0 && cost > 0;
  const costPercent = showCostBar ? Math.min(100, (cost / costLimitUsd!) * 100) : 0;
  const overLimit = showCostBar && cost >= costLimitUsd!;

  return (
    <span className="flex items-center gap-2 text-xs text-neutral-400">
      {running ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> : null}
      <span title={`input tokens: ${usage.inputTokens}`}>↑{fmt(usage.inputTokens)}</span>
      <span title={`output tokens: ${usage.outputTokens}`}>↓{fmt(usage.outputTokens)}</span>
      {usage.totalTokens > 0 ? <span title="total tokens">Σ{fmt(usage.totalTokens)}</span> : null}
      {cost > 0 ? (
        <span
          title={`cost: $${cost.toFixed(4)} / limit: $${(costLimitUsd ?? 0).toFixed(4)}`}
          className={overLimit ? 'font-medium text-red-400' : showCostBar && costPercent >= 80 ? 'text-amber-400' : ''}
        >
          ${cost.toFixed(cost < 0.01 ? 4 : 2)}
        </span>
      ) : null}
      {showCostBar ? (
        <span className="inline-block h-1 w-16 overflow-hidden rounded bg-neutral-700 align-middle" title={`成本 ${costPercent.toFixed(0)}%`}>
          <span
            className={`block h-full ${overLimit ? 'bg-red-500' : costPercent >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.max(2, costPercent)}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}