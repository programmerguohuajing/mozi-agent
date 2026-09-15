import type { SessionState, SessionSummary } from '@mozi/protocol';
/**
 * 会话侧栏 — Mozi Studio
 * 仿 ChatGPT：导航菜单 + 置顶分组 + 项目级会话分组。
 * 支持 i18n + 三套主题。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

/** 纯色 SVG 图标集（使用 currentColor，随主题切换）。 */
const Icons: Record<string, React.ReactElement> = {
  chat: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M2 3h12v8H5l-3 3V3z" strokeLinejoin="round" />
    </svg>
  ),
  pulls: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="4" cy="4" r="1.8" />
      <circle cx="4" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <path
        d="M4 5.8v4.4M4 12h8M12 10.2V6a2 2 0 0 0-2-2H7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  schedule: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="9" r="5.5" />
      <path d="M8 6v3l2 2M5.5 1.5h5M6.5 3.5h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  plugins: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path
        d="M6 2v2.5a1.5 1.5 0 0 0 3 0V2h2v4h2.5a1.5 1.5 0 0 1 0 3H11v5H2v-5h.5a1.5 1.5 0 0 0 0-3H2V2h4z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  skills: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path
        d="M3 2l2 2v3l-2 2v3l2 2M13 2l-2 2v3l2 2v3l-2 2M6 4l2 2M10 4l-2 2M8 10v3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  security: (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M8 1.5L3 4v5c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V4l-5-2.5z" strokeLinejoin="round" />
    </svg>
  ),
  folder: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M2 4h4l1.5 2H14v8H2V4z" strokeLinejoin="round" />
    </svg>
  ),
};

export type NavTab =
  | 'chat'
  | 'pulls'
  | 'schedule'
  | 'plugins'
  | 'skills'
  | 'security'
  | 'subagents'
  | 'dashboard'
  | 'settings';

export interface SidebarProps {
  sessions: SessionSummary[];
  activeSessionId?: string;
  activeNav: NavTab;
  onNavChange: (nav: NavTab) => void;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onFork: (sessionId: string) => void;
}

function groupByProject(
  sessions: SessionSummary[],
): Array<{ project: string; sessions: SessionSummary[] }> {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.project ?? s.workspace ?? '其他';
    const list = groups.get(key);
    if (list) {
      list.push(s);
    } else {
      groups.set(key, [s]);
    }
  }
  return [...groups.entries()]
    .map(([project, ss]) => ({
      project,
      sessions: ss.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''));
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  const { t } = useApp();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const groups = groupByProject(props.sessions);

  const stateBadge = (state: SessionState): { label: string; cls: string } => {
    const map: Record<SessionState, { label: string; cls: string }> = {
      idle: { label: t('status.idle'), cls: 'badge-idle' },
      running: { label: t('status.running'), cls: 'badge-running' },
      pending_approval: { label: t('status.pending_approval'), cls: 'badge-pending' },
      completed: { label: t('status.completed'), cls: 'badge-completed' },
      failed: { label: t('status.failed'), cls: 'badge-failed' },
    };
    return map[state] ?? map.idle;
  };

  const navItems: Array<{ key: NavTab; label: string; icon: keyof typeof Icons }> = [
    { key: 'chat', label: t('nav.chat'), icon: 'chat' },
    { key: 'pulls', label: t('nav.pulls'), icon: 'pulls' },
    { key: 'schedule', label: t('nav.schedule'), icon: 'schedule' },
    { key: 'plugins', label: t('nav.plugins'), icon: 'plugins' },
    { key: 'skills', label: t('nav.skills'), icon: 'skills' },
    { key: 'security', label: t('nav.security'), icon: 'security' },
  ];

  const toggle = (project: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">M</div>
          <span>{t('app.name')}</span>
        </div>
        <button className="btn-new" onClick={props.onNew}>
          {t('app.new')}
        </button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <div
            key={item.key}
            className={`nav-item ${props.activeNav === item.key ? 'active' : ''}`}
            onClick={() => props.onNavChange(item.key)}
          >
            <span className="nav-icon">{Icons[item.icon]}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </nav>

      <div className="pinned-section">
        <div className="pinned-header">{t('sidebar.pinned')} (0)</div>
      </div>

      <div className="session-list">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.project);
          const hasActive = group.sessions.some((s) => s.id === props.activeSessionId);
          return (
            <div key={group.project} className="project-group">
              <div
                className={`project-header ${hasActive ? 'has-active' : ''}`}
                onClick={() => toggle(group.project)}
              >
                <span className="project-arrow">{isCollapsed ? '▶' : '▼'}</span>
                <span className="project-icon">{Icons.folder}</span>
                <span className="project-name">{group.project}</span>
                <span className="project-count">{group.sessions.length}</span>
              </div>
              {!isCollapsed &&
                group.sessions.map((s) => {
                  const badge = stateBadge(s.state);
                  const active = s.id === props.activeSessionId;
                  return (
                    <div
                      key={s.id}
                      className={`session-item ${active ? 'active' : ''}`}
                      onClick={() => props.onSelect(s.id)}
                    >
                      <div className="session-item-top">
                        <span className="session-name">{s.model ?? s.id.slice(0, 12)}</span>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </div>
                      <div className="session-meta">
                        <span>{s.updatedAt?.slice(0, 16).replace('T', ' ') ?? '-'}</span>
                        {s.usage ? <span>{s.usage.totalTokens} tok</span> : null}
                        <div className="session-actions">
                          <button
                            title="fork"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onFork(s.id);
                            }}
                          >
                            ⑂
                          </button>
                          <button
                            className="danger"
                            title="delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onDelete(s.id);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
        {props.sessions.length === 0 ? (
          <div className="empty-list">{t('session.empty.list')}</div>
        ) : null}
      </div>
    </aside>
  );
}
