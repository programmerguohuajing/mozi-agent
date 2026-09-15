import type { ScheduleTaskInfo } from '@mozi/protocol';
/**
 * 定时任务面板 — Mozi Studio
 * 真实数据源：schedule:list / create / toggle / delete / runNow（TaskSchedulerHost）。
 * 无人值守执行链：cron 到期 → headless 引擎（审批一律 deny）→ 报告落盘。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

/** 新建表单草稿。 */
interface Draft {
  name: string;
  cron: string;
  prompt: string;
  workspace: string;
  policyMode: 'readonly' | 'allowlist' | 'full';
  notify: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  cron: '0 9 * * *',
  prompt: '',
  workspace: '',
  policyMode: 'readonly',
  notify: true,
};

const STATUS_ICONS: Record<ScheduleTaskInfo['lastStatus'], string> = {
  success: '✅',
  failed: '❌',
  pending: '⏳',
  never: '○',
  'skipped-overlap': '⏭',
  timeout: '⏱',
};

const POLICY_LABELS: Record<Draft['policyMode'], string> = {
  readonly: '只读（推荐）',
  allowlist: '白名单',
  full: '完全放开',
};

/** cron 人类可读预览（常见模式的简化描述）。 */
function cronHint(cron: string): string {
  // 缺字段的解构默认空串，统一走下方真值早退（noUncheckedIndexedAccess 下 some() 守卫无法收窄）。
  const [min = '', hour = '', dom = '', mon = '', dow = ''] = cron.trim().split(/\s+/);
  if (!min || !hour || !dom || !mon || !dow) return '';
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*')
    return `每天 ${hour}:${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '1') return `每周一 ${hour}:${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow !== '*')
    return `每周${dow} ${hour}:${min.padStart(2, '0')}`;
  if (dom !== '*' && mon === '*' && dow === '*')
    return `每月 ${dom} 日 ${hour}:${min.padStart(2, '0')}`;
  if (min === '0' && hour === '*') return '每小时';
  if (min === '*/30' && hour === '*') return '每 30 分钟';
  if (min.startsWith('*/') && hour === '*') return `每 ${min.slice(2)} 分钟`;
  return '';
}

export interface SchedulePanelProps {
  tasks: ScheduleTaskInfo[];
  /** 运行中的任务 id（进行时反馈）。 */
  runningIds: string[];
  onCreate: (req: {
    name: string;
    cron: string;
    prompt: string;
    workspace: string;
    policyMode: Draft['policyMode'];
    notify: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
  /** 打开原生目录选择框选工作区。 */
  onPickWorkspace: () => Promise<string | null>;
}

export function SchedulePanel(props: SchedulePanelProps): React.ReactElement {
  const { t } = useApp();
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const set = (patch: Partial<Draft>): void => {
    setDraft((p) => ({ ...p, ...patch }));
  };

  const submit = async (): Promise<void> => {
    setFormError('');
    setCreating(true);
    try {
      const r = await props.onCreate({
        name: draft.name,
        cron: draft.cron,
        prompt: draft.prompt,
        workspace: draft.workspace,
        policyMode: draft.policyMode,
        notify: draft.notify,
      });
      if (r.ok) {
        setDraft(EMPTY_DRAFT);
        setShowForm(false);
      } else {
        setFormError(r.error ?? t('sched.form.error'));
      }
    } finally {
      setCreating(false);
    }
  };

  const hint = cronHint(draft.cron);

  return (
    <div className="page-container">
      <div className="page-title">{t('sched.title')}</div>
      <div className="page-subtitle">{t('sched.subtitle')}</div>

      <div className="page-toolbar">
        <button className="btn-sm primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? t('sched.form.cancel') : t('sched.create')}
        </button>
      </div>

      {/* 新建表单 */}
      {showForm ? (
        <div className="sched-form">
          <input
            className="input-field"
            placeholder={t('sched.form.name')}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="input-row-group">
            <input
              className="input-field"
              style={{ flex: '0 0 200px', fontFamily: 'var(--font-mono)' }}
              placeholder="0 9 * * *"
              value={draft.cron}
              onChange={(e) => set({ cron: e.target.value })}
            />
            {hint ? <span className="sched-cron-hint">{hint}</span> : null}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('sched.form.cronHint')}</div>
          <textarea
            className="input-field"
            style={{ minHeight: 90, resize: 'vertical' }}
            placeholder={t('sched.form.prompt')}
            value={draft.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
          />
          <div className="input-row-group">
            <input
              className="input-field"
              style={{ flex: 1 }}
              placeholder={t('sched.form.workspace')}
              value={draft.workspace}
              onChange={(e) => set({ workspace: e.target.value })}
            />
            <button
              className="btn-sm"
              onClick={() =>
                void props.onPickWorkspace().then((p) => {
                  if (p) set({ workspace: p });
                })
              }
            >
              {t('sched.form.browse')}
            </button>
          </div>
          <div className="input-row-group">
            <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{t('sched.form.policy')}</span>
            {(['readonly', 'allowlist', 'full'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-switch-btn${draft.policyMode === m ? ' active' : ''}`}
                onClick={() => set({ policyMode: m })}
              >
                {POLICY_LABELS[m]}
              </button>
            ))}
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--text-2)',
            }}
          >
            <input
              type="checkbox"
              checked={draft.notify}
              onChange={(e) => set({ notify: e.target.checked })}
            />
            {t('sched.form.notify')}
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              className="btn-sm"
              onClick={() => {
                setShowForm(false);
                setFormError('');
              }}
            >
              {t('sched.form.cancel')}
            </button>
            <button className="btn-sm primary" disabled={creating} onClick={() => void submit()}>
              {creating ? t('sched.form.creating') : t('sched.form.submit')}
            </button>
          </div>
          {formError ? <div className="test-result fail">{formError}</div> : null}
        </div>
      ) : null}

      <div className="schedule-list">
        {props.tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⏰</div>
            <div className="empty-state-text">{t('sched.empty.title')}</div>
            <div className="empty-state-hint">{t('sched.empty.hint')}</div>
          </div>
        ) : (
          props.tasks.map((task) => {
            const running = props.runningIds.includes(task.id);
            return (
              <div key={task.id} className={`schedule-card${task.enabled ? '' : ' disabled'}`}>
                <span className="schedule-icon">
                  {running ? '◐' : STATUS_ICONS[task.lastStatus]}
                </span>
                <div className="schedule-info">
                  <div className="schedule-name">{task.name}</div>
                  <div className="schedule-cron">{task.cron}</div>
                  <div className="schedule-next">
                    {t('sched.next')}
                    {new Date(task.nextRun).toLocaleString()}
                  </div>
                  {task.workspace ? (
                    <div className="schedule-workspace" title={task.workspace}>
                      📁 {task.workspace}
                    </div>
                  ) : null}
                </div>
                <button
                  className="btn-sm"
                  disabled={running}
                  title={t('sched.runNow')}
                  onClick={() => props.onRunNow(task.id)}
                >
                  {running ? t('sched.running') : '▶'}
                </button>
                <button
                  className="skill-delete-btn"
                  title={t('sched.delete')}
                  onClick={() => props.onDelete(task.id)}
                >
                  ✕
                </button>
                <label className="skill-toggle schedule-toggle">
                  <input
                    type="checkbox"
                    checked={task.enabled}
                    onChange={() => props.onToggle(task.id)}
                  />
                  <span className="skill-toggle-slider" />
                </label>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
