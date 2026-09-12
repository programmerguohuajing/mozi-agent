/**
 * 会话侧栏 — Mozi Studio
 * 仿 ChatGPT：导航菜单 + 置顶分组 + 项目级会话分组。
 * 支持 i18n + 三套主题。
 */
import * as React from 'react';
import type { SessionSummary, SessionState } from '@mozi/protocol';
import { useApp } from '../i18n.js';

export type NavTab = 'chat' | 'pulls' | 'schedule' | 'plugins' | 'skills' | 'security' | 'subagents' | 'dashboard' | 'settings';

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

function groupByProject(sessions: SessionSummary[]): Array<{ project: string; sessions: SessionSummary[] }> {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.project ?? s.workspace ?? '其他';
    const list = groups.get(key);
    if (list) { list.push(s); } else { groups.set(key, [s]); }
  }
  return [...groups.entries()].map(([project, ss]) => ({
    project,
    sessions: ss.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
  })).sort((a, b) => (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''));
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

  const navItems: Array<{ key: NavTab; label: string; icon: string }> = [
    { key: 'chat', label: t('nav.chat'), icon: '✏️' },
    { key: 'pulls', label: t('nav.pulls'), icon: '🔀' },
    { key: 'schedule', label: t('nav.schedule'), icon: '⏰' },
    { key: 'plugins', label: t('nav.plugins'), icon: '🧩' },
    { key: 'security', label: t('nav.security'), icon: '🛡️' },
  ];

  const toggle = (project: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project); else next.add(project);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">墨</div>
          <span>{t('app.name')}</span>
        </div>
        <button className="btn-new" onClick={props.onNew}>{t('app.new')}</button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <div key={item.key} className={`nav-item ${props.activeNav === item.key ? 'active' : ''}`} onClick={() => props.onNavChange(item.key)}>
            <span className="nav-icon">{item.icon}</span>
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
              <div className={`project-header ${hasActive ? 'has-active' : ''}`} onClick={() => toggle(group.project)}>
                <span className="project-arrow">{isCollapsed ? '▶' : '▼'}</span>
                <span className="project-icon">📁</span>
                <span className="project-name">{group.project}</span>
                <span className="project-count">{group.sessions.length}</span>
              </div>
              {!isCollapsed && group.sessions.map((s) => {
                const badge = stateBadge(s.state);
                const active = s.id === props.activeSessionId;
                return (
                  <div key={s.id} className={`session-item ${active ? 'active' : ''}`} onClick={() => props.onSelect(s.id)}>
                    <div className="session-item-top">
                      <span className="session-name">{s.model ?? s.id.slice(0, 12)}</span>
                      <span className={`badge ${badge.cls}`}>{badge.label}</span>
                    </div>
                    <div className="session-meta">
                      <span>{s.updatedAt?.slice(0, 16).replace('T', ' ') ?? '-'}</span>
                      {s.usage ? <span>{s.usage.totalTokens} tok</span> : null}
                      <div className="session-actions">
                        <button title="fork" onClick={(e) => { e.stopPropagation(); props.onFork(s.id); }}>⑂</button>
                        <button className="danger" title="delete" onClick={(e) => { e.stopPropagation(); props.onDelete(s.id); }}>✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {props.sessions.length === 0 ? <div className="empty-list">{t('session.empty.list')}</div> : null}
      </div>
    </aside>
  );
}
