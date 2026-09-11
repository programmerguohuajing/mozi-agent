/**
 * 仪表盘（M10 §10.5⑤）：token 用量趋势（按天）、工具调用统计、审批统计、各模型成本。
 * 纯 SVG 手绘（零图表依赖），配色遵循中文金融惯例（涨红跌绿不适用，此处用中性色）。
 */
import * as React from 'react';
import type { DashboardStats } from '@mozi/protocol';

export interface DashboardProps {
  stats: DashboardStats;
}

function BarChart({
  data,
  height = 100,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
}): React.ReactElement {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 24;
  return (
    <svg width={Math.max(120, data.length * (w + 6))} height={height + 20} className="text-neutral-300">
      {data.map((d, i) => {
        const h = Math.round((d.value / max) * height);
        return (
          <g key={d.label}>
            <rect
              x={i * (w + 6)}
              y={height - h}
              width={w}
              height={h}
              rx={2}
              className="fill-emerald-600"
            />
            <text x={i * (w + 6) + w / 2} y={height + 12} textAnchor="middle" className="fill-neutral-500 text-[9px]">
              {d.label.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Dashboard(props: DashboardProps): React.ReactElement {
  const { stats } = props;
  const tokenData = stats.tokensByDay.map((d) => ({
    label: d.date,
    value: d.input + d.output,
  }));

  return (
    <div className="space-y-4 overflow-auto p-4 text-sm">
      <section className="rounded-lg border border-neutral-700 p-3">
        <h2 className="mb-2 text-sm font-medium">Token 用量（按天）</h2>
        {tokenData.length ? <BarChart data={tokenData} /> : <div className="text-xs text-neutral-600">（无数据）</div>}
      </section>

      <div className="grid grid-cols-2 gap-4">
        <section className="rounded-lg border border-neutral-700 p-3">
          <h2 className="mb-2 text-sm font-medium">工具调用统计</h2>
          <ul className="space-y-1 text-xs">
            {stats.toolCalls.map((t) => (
              <li key={t.name} className="flex justify-between">
                <span className="font-mono text-neutral-400">{t.name}</span>
                <span>{t.count}</span>
              </li>
            ))}
            {stats.toolCalls.length === 0 ? <li className="text-neutral-600">（无数据）</li> : null}
          </ul>
        </section>

        <section className="rounded-lg border border-neutral-700 p-3">
          <h2 className="mb-2 text-sm font-medium">审批统计</h2>
          <div className="flex gap-4 text-xs">
            <span className="text-emerald-400">允许 {stats.approvals.allow}</span>
            <span className="text-red-400">拒绝 {stats.approvals.deny}</span>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-neutral-700 p-3">
        <h2 className="mb-2 text-sm font-medium">各模型成本</h2>
        <ul className="space-y-1 text-xs">
          {stats.costByModel.map((c) => (
            <li key={c.model} className="flex justify-between">
              <span className="font-mono text-neutral-400">{c.model}</span>
              <span>${c.costUsd.toFixed(4)}</span>
            </li>
          ))}
          {stats.costByModel.length === 0 ? <li className="text-neutral-600">（无数据）</li> : null}
        </ul>
      </section>
    </div>
  );
}
