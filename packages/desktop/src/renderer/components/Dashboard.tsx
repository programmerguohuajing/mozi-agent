import type { DashboardStats } from '@mozi/protocol';
/**
 * 仪表盘 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface DashboardProps {
  stats: DashboardStats;
}

const CHART_COLORS = [
  '#5b8def',
  '#5b8def',
  '#3fb950',
  '#a371f7',
  '#3fb950',
  '#a371f7',
  '#5b8def',
  '#5b8def',
];

function BarChart({
  data,
  height = 120,
}: { data: Array<{ label: string; value: number }>; height?: number }): React.ReactElement {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="chart-bars">
        {data.map((d, i) => {
          const h = Math.round((d.value / max) * height);
          return (
            <div
              key={d.label}
              className="chart-bar"
              style={{ height: h, background: CHART_COLORS[i % CHART_COLORS.length] }}
            >
              <span className="bar-val">{(d.value / 1000).toFixed(0)}k</span>
            </div>
          );
        })}
      </div>
      <div className="chart-labels">
        {data.map((d) => (
          <div key={d.label} className="chart-label">
            {d.label.slice(5)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard(props: DashboardProps): React.ReactElement {
  const { t } = useApp();
  const { stats } = props;
  const tokenData = stats.tokensByDay.map((d) => ({ label: d.date, value: d.input + d.output }));
  const maxToolCount = Math.max(1, ...stats.toolCalls.map((t) => t.count));
  const maxCost = Math.max(0.01, ...stats.costByModel.map((c) => c.costUsd));
  const totalTokens = stats.tokensByDay.reduce((s, d) => s + d.input + d.output, 0);
  const totalToolCalls = stats.toolCalls.reduce((s, t) => s + t.count, 0);
  const totalCost = stats.costByModel.reduce((s, c) => s + c.costUsd, 0);
  const approvalRate =
    stats.approvals.allow + stats.approvals.deny > 0
      ? ((stats.approvals.deny / (stats.approvals.allow + stats.approvals.deny)) * 100).toFixed(1)
      : '0.0';

  const fmt = (n: number): string =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : String(n);

  return (
    <div className="dashboard">
      <div className="dash-title">{t('dash.title')}</div>
      <div className="dash-subtitle">{t('dash.subtitle')}</div>

      <div className="stat-cards">
        <div className="stat-card primary">
          <div className="stat-label">{t('dash.stat.tokens')}</div>
          <div className="stat-value">{fmt(totalTokens)}</div>
        </div>
        <div className="stat-card success">
          <div className="stat-label">{t('dash.stat.tools')}</div>
          <div className="stat-value">{totalToolCalls.toLocaleString()}</div>
        </div>
        <div className="stat-card warning">
          <div className="stat-label">{t('dash.stat.cost')}</div>
          <div className="stat-value">${totalCost.toFixed(2)}</div>
        </div>
        <div className="stat-card danger">
          <div className="stat-label">{t('dash.stat.deny')}</div>
          <div className="stat-value">{approvalRate}%</div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="dash-panel">
          <div className="dash-panel-title">{t('dash.panel.tokens')}</div>
          {tokenData.length > 0 ? (
            <BarChart data={tokenData} />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('dash.empty')}</div>
          )}
        </div>
        <div className="dash-panel">
          <div className="dash-panel-title">{t('dash.panel.tools')}</div>
          <ul className="tool-list">
            {stats.toolCalls.map((t, i) => (
              <li key={t.name} className="tool-row">
                <span className="tool-row-name">{t.name}</span>
                <div className="tool-bar-bg">
                  <div
                    className="tool-bar-fill"
                    style={{
                      width: `${(t.count / maxToolCount) * 100}%`,
                      background: CHART_COLORS[i % CHART_COLORS.length],
                    }}
                  />
                </div>
                <span className="tool-row-count">{t.count}</span>
              </li>
            ))}
            {stats.toolCalls.length === 0 ? (
              <li style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('dash.empty')}</li>
            ) : null}
          </ul>
        </div>
      </div>

      <div className="dash-grid">
        <div className="dash-panel">
          <div className="dash-panel-title">{t('dash.panel.approvals')}</div>
          <div className="approval-stats">
            <div className="approval-stat">
              <div className="approval-stat-value allow">{stats.approvals.allow}</div>
              <div className="approval-stat-label">{t('dash.approval.allow')}</div>
            </div>
            <div className="approval-divider" />
            <div className="approval-stat">
              <div className="approval-stat-value deny">{stats.approvals.deny}</div>
              <div className="approval-stat-label">{t('dash.approval.deny')}</div>
            </div>
          </div>
        </div>
        <div className="dash-panel">
          <div className="dash-panel-title">{t('dash.panel.cost')}</div>
          <ul className="cost-list">
            {stats.costByModel.map((c) => (
              <li key={c.model} className="cost-row">
                <span className="cost-model">{c.model}</span>
                <div className="cost-bar-bg">
                  <div
                    className="cost-bar-fill"
                    style={{ width: `${(c.costUsd / maxCost) * 100}%` }}
                  />
                </div>
                <span className="cost-amount">${c.costUsd.toFixed(4)}</span>
              </li>
            ))}
            {stats.costByModel.length === 0 ? (
              <li style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('dash.empty')}</li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
