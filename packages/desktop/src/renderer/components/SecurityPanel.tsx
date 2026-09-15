/**
 * 安全面板 — Mozi Studio (i18n + 三主题)
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface SecurityPanelProps {
  sandboxLevel: 0 | 1 | 2 | 3;
  policyMode: string;
  approvalStats: { allow: number; deny: number };
  onSetSandboxLevel: (level: 0 | 1 | 2 | 3) => void;
}

export function SecurityPanel(props: SecurityPanelProps): React.ReactElement {
  const { t } = useApp();
  const total = props.approvalStats.allow + props.approvalStats.deny;
  const denyRate = total > 0 ? ((props.approvalStats.deny / total) * 100).toFixed(1) : '0.0';
  const sandboxLabels: Record<number, string> = {
    0: t('sandbox.L0'),
    1: t('sandbox.L1'),
    2: t('sandbox.L2'),
    3: t('sandbox.L3'),
  };
  const en = (b: boolean) => (b ? t('sec.sandbox.enabled') : t('sec.sandbox.disabled'));

  return (
    <div className="page-container">
      <div className="page-title">{t('sec.title')}</div>
      <div className="page-subtitle">{t('sec.subtitle')}</div>

      <div className="security-grid">
        <div className="security-card">
          <div className="security-card-title">
            <span>🔒</span> {t('sec.sandbox')}
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.sandbox.level')}</span>
            <span className="security-value ok">{sandboxLabels[props.sandboxLevel]}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.sandbox.process')}</span>
            <span className={`security-value ${props.sandboxLevel >= 1 ? 'ok' : 'warn'}`}>
              {en(props.sandboxLevel >= 1)}
            </span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.sandbox.platform')}</span>
            <span className={`security-value ${props.sandboxLevel >= 2 ? 'ok' : 'warn'}`}>
              {en(props.sandboxLevel >= 2)}
            </span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.sandbox.docker')}</span>
            <span className={`security-value ${props.sandboxLevel >= 3 ? 'ok' : 'warn'}`}>
              {en(props.sandboxLevel >= 3)}
            </span>
          </div>
          <div style={{ marginTop: 12 }}>
            <select
              className="select-field"
              style={{ width: '100%' }}
              value={props.sandboxLevel}
              onChange={(e) => props.onSetSandboxLevel(Number(e.target.value) as 0 | 1 | 2 | 3)}
            >
              {[0, 1, 2, 3].map((l) => (
                <option key={l} value={l}>
                  {sandboxLabels[l]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="security-card">
          <div className="security-card-title">
            <span>🛡</span> {t('sec.policy')}
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.policy.mode')}</span>
            <span className="security-value">{props.policyMode}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.policy.approved')}</span>
            <span className="security-value ok">{props.approvalStats.allow}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.policy.denied')}</span>
            <span className="security-value fail">{props.approvalStats.deny}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.policy.denyRate')}</span>
            <span
              className={`security-value ${Number(denyRate) > 10 ? 'fail' : Number(denyRate) > 5 ? 'warn' : 'ok'}`}
            >
              {denyRate}%
            </span>
          </div>
        </div>

        <div className="security-card">
          <div className="security-card-title">
            <span>🔑</span> {t('sec.keys')}
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.keys.os')}</span>
            <span className="security-value ok">{t('sec.sandbox.enabled')}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.keys.noLeak')}</span>
            <span className="security-value ok">{t('sec.keys.yes')}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.keys.masked')}</span>
            <span className="security-value ok">{t('sec.sandbox.enabled')}</span>
          </div>
        </div>

        <div className="security-card">
          <div className="security-card-title">
            <span>📋</span> {t('sec.audit')}
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.audit.log')}</span>
            <span className="security-value ok">{t('sec.sandbox.enabled')}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.audit.persist')}</span>
            <span className="security-value ok">events.jsonl</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.audit.approval')}</span>
            <span className="security-value ok">{t('sec.audit.complete')}</span>
          </div>
          <div className="security-row">
            <span className="security-label">{t('sec.audit.resume')}</span>
            <span className="security-value ok">{t('sec.audit.supported')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
