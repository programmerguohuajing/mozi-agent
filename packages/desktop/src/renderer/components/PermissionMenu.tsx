/**
 * 权限模式选择器 — 输入栏右侧徽标，点击向上弹出三档访问模式。
 *
 * 与 @mozi/shared 的 PolicyMode 映射（决策表见 @mozi/policy 的 DEFAULT_TABLE）：
 *   readonly  → 请求批准     （写文件 / 执行命令需批准，网络与敏感路径命中内置规则）
 *   auto      → 帮我批准     （仅风险操作请求批准）
 *   full-auto → 完全访问权限 （不受限制）
 *
 * 选择结果通过 onSelect 回传，由宿主写入 config:set（持久化 policyMode）。
 */
import * as React from 'react';
import type { PolicyMode } from '@mozi/shared';
import { useApp } from '../i18n.js';

export interface PermissionMenuProps {
  /** 当前策略模式。 */
  mode: PolicyMode;
  /** 选中某一档（宿主负责持久化）。 */
  onSelect: (mode: PolicyMode) => void;
}

interface Option {
  mode: PolicyMode;
  /** 徽标配色变体（沿用 styles.css 中已有的 .perm-badge 变体）。 */
  variant: string;
  icon: string;
  /** 菜单项标题。 */
  labelKey: string;
  /** 徽标短标题。 */
  badgeKey: string;
  descKey: string;
}

const OPTIONS: Option[] = [
  { mode: 'readonly', variant: 'readonly', icon: '🔒', labelKey: 'perm.request', badgeKey: 'perm.badge.readonly', descKey: 'perm.request.desc' },
  { mode: 'auto', variant: 'limited', icon: '🛡', labelKey: 'perm.auto', badgeKey: 'perm.badge.auto', descKey: 'perm.auto.desc' },
  { mode: 'full-auto', variant: 'full', icon: '⚡', labelKey: 'perm.full', badgeKey: 'perm.badge.full', descKey: 'perm.full.desc' },
];

const FALLBACK: Option = OPTIONS[1] as Option;

export function PermissionMenu(props: PermissionMenuProps): React.ReactElement {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  const current = OPTIONS.find((o) => o.mode === props.mode) ?? FALLBACK;

  // 点击面板外部或按 Esc 关闭。
  React.useEffect(() => {
    if (!open) return;
    const onDocDown = (e: Event): void => {
      const target = e.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="perm-menu" ref={wrapRef}>
      <button
        type="button"
        className={`perm-badge ${current.variant}${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('perm.menu.title')}
      >
        {t(current.badgeKey)}
        <svg
          className={`perm-caret${open ? ' open' : ''}`}
          width="8" height="8" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 6.5 5 3.5 8 6.5" />
        </svg>
      </button>

      {open ? (
        <div className="perm-menu-pop" role="menu" aria-label={t('perm.menu.title')}>
          <div className="perm-menu-title">{t('perm.menu.title')}</div>
          {OPTIONS.map((o) => {
            const active = o.mode === props.mode;
            return (
              <button
                key={o.mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`perm-menu-item${active ? ' active' : ''}`}
                onClick={() => {
                  props.onSelect(o.mode);
                  setOpen(false);
                }}
              >
                <span className="perm-menu-icon" aria-hidden="true">{o.icon}</span>
                <span className="perm-menu-text">
                  <span className="perm-menu-item-title">{t(o.labelKey)}</span>
                  <span className="perm-menu-item-desc">{t(o.descKey)}</span>
                </span>
                <span className="perm-menu-check" aria-hidden="true">{active ? '✓' : ''}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
