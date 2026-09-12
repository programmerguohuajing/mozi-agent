/**
 * Pull Request 管理面板 — Mozi Studio
 * 仿 ChatGPT 桌面端 PR 列表。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface PRInfo {
  id: number;
  title: string;
  branch: string;
  status: 'open' | 'merged' | 'closed' | 'draft';
  additions: number;
  deletions: number;
  changedFiles: number;
  author: string;
  updatedAt: string;
  project: string;
}

export interface PullRequestPanelProps {
  prs: PRInfo[];
  onSelect?: (prId: number) => void;
}

export function PullRequestPanel(props: PullRequestPanelProps): React.ReactElement {
  const { t } = useApp();
  const [filter, setFilter] = React.useState<PRInfo['status'] | 'all'>('all');

  const STATUS_LABELS: Record<PRInfo['status'], string> = {
    open: t('pr.status.open'), merged: t('pr.status.merged'), closed: t('pr.status.closed'), draft: t('pr.status.draft'),
  };

  const filtered = props.prs.filter((pr) => filter === 'all' || pr.status === filter);
  const counts = {
    all: props.prs.length,
    open: props.prs.filter((p) => p.status === 'open').length,
    merged: props.prs.filter((p) => p.status === 'merged').length,
    draft: props.prs.filter((p) => p.status === 'draft').length,
  };

  return (
    <div className="page-container">
      <div className="page-title">{t('pr.title')}</div>
      <div className="page-subtitle">{t('pr.subtitle')}</div>

      <div className="page-toolbar">
        {(['all', 'open', 'merged', 'draft'] as const).map((s) => (
          <button key={s} className={`skill-filter-btn ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? `${t('pr.filter.all')} (${counts.all})` : s === 'open' ? `${t('pr.filter.open')} (${counts.open})` : s === 'merged' ? `${t('pr.filter.merged')} (${counts.merged})` : `${t('pr.filter.draft')} (${counts.draft})`}
          </button>
        ))}
      </div>

      <div className="pr-list">
        {filtered.length === 0 ? (
            <div className="empty-state">
            <div className="empty-state-icon">🔀</div>
            <div className="empty-state-text">{t('pr.empty')}</div>
          </div>
        ) : (
          filtered.map((pr) => (
            <div key={pr.id} className="pr-card" onClick={() => props.onSelect?.(pr.id)}>
              <div className="pr-card-top">
                <span className={`pr-status-dot ${pr.status}`}></span>
                <span className="pr-title">{pr.title}</span>
                <span className="pr-number">#{pr.id}</span>
              </div>
              <div className="pr-meta">
                <span className="pr-branch">{pr.branch}</span>
                <span className="file-change-add">+{pr.additions}</span>
                <span className="file-change-del">-{pr.deletions}</span>
                <span>{pr.changedFiles} {t('pr.files')}</span>
                <span>{pr.author}</span>
                <span>{pr.updatedAt.slice(0, 10)}</span>
                <span className={`pr-badge ${pr.status}`} style={{ marginLeft: 'auto' }}>{STATUS_LABELS[pr.status]}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
