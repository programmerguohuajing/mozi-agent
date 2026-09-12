/**
 * 定时任务面板 — Mozi Studio
 * 仿 ChatGPT 桌面端定时任务管理。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface ScheduleTask {
  id: string;
  name: string;
  cron: string;
  nextRun: string;
  enabled: boolean;
  lastStatus: 'success' | 'failed' | 'pending' | 'never';
  project?: string;
}

export interface SchedulePanelProps {
  tasks: ScheduleTask[];
  onToggle: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onCreate: () => void;
}

const STATUS_ICONS: Record<ScheduleTask['lastStatus'], string> = {
  success: '✅', failed: '❌', pending: '⏳', never: '○',
};

export function SchedulePanel(props: SchedulePanelProps): React.ReactElement {
  const { t } = useApp();
  return (
    <div className="page-container">
      <div className="page-title">{t('sched.title')}</div>
      <div className="page-subtitle">{t('sched.subtitle')}</div>

      <div className="page-toolbar">
        <button className="btn-sm primary" onClick={props.onCreate}>{t('sched.create')}</button>
      </div>

      <div className="schedule-list">
        {props.tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⏰</div>
            <div className="empty-state-text">{t('sched.empty.title')}</div>
            <div className="empty-state-hint">{t('sched.empty.hint')}</div>
          </div>
        ) : (
          props.tasks.map((task) => (
            <div key={task.id} className="schedule-card">
              <span className="schedule-icon">{STATUS_ICONS[task.lastStatus]}</span>
              <div className="schedule-info">
                <div className="schedule-name">{task.name}</div>
                <div className="schedule-cron">{task.cron}</div>
                <div className="schedule-next">{t('sched.next')}{task.nextRun}</div>
              </div>
              {task.project ? <span className="skill-trigger-tag">{task.project}</span> : null}
              <button className="skill-delete-btn" title="删除" onClick={() => props.onDelete(task.id)}>✕</button>
              <label className="skill-toggle schedule-toggle">
                <input type="checkbox" checked={task.enabled} onChange={() => props.onToggle(task.id)} />
                <span className="skill-toggle-slider"></span>
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
