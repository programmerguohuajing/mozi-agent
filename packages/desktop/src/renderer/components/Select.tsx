/**
 * 自定义下拉框（替换原生 <select>）。
 * - 触发器：显示当前选中项 + 下拉箭头
 * - 弹层：绝对定位选项列表，支持 hover / 选中态 / 右侧浅色说明文字
 * - 交互：点击外部关闭、Esc 关闭
 * - 样式：全部走全局 CSS 变量（styles.css 的 .mozi-select-*），随主题切换
 */
import * as React from 'react';

export interface SelectOption {
  value: string;
  label: string;
  /** 选项右侧的浅色说明（如示例 Base URL）。 */
  hint?: string;
  /** 选项下方的次级说明行。 */
  sub?: string;
  /** 分组标题：同组选项连续渲染在标题下方（如模型选择器按提供商分组）。 */
  group?: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 未选中时的占位文本（也用于空列表提示）。 */
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** 触发器最小宽度（px）。 */
  minWidth?: number;
  /** 弹层右对齐（组件贴近屏幕右缘时防止溢出）。 */
  alignRight?: boolean;
}

export function Select(props: SelectProps): React.ReactElement {
  const { value, options, onChange, placeholder, disabled, style, minWidth, alignRight } = props;
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  // 分组选项：触发器显示「分组 — 标签」（如模型选择器「deepseek — deepseek-chat」）。
  const triggerLabel = current
    ? current.group !== undefined
      ? `${current.group} — ${current.label}`
      : current.label
    : (placeholder ?? '');

  // 分组渲染：相邻同 group 的选项之间插入一次分组标题（不可选）。
  const renderOptions = (): Array<React.ReactElement> => {
    const out: Array<React.ReactElement> = [];
    let lastGroup: string | undefined;
    for (const o of options) {
      if (o.group !== undefined && o.group !== lastGroup) {
        out.push(
          <div key={`__group_${o.group}`} className="mozi-select-group" role="presentation">
            {o.group}
          </div>,
        );
      }
      lastGroup = o.group;
      out.push(
        <button
          type="button"
          key={o.value}
          role="option"
          aria-selected={o.value === value}
          className={`mozi-select-option${o.value === value ? ' active' : ''}`}
          onClick={() => {
            onChange(o.value);
            setOpen(false);
          }}
        >
          <span className="mozi-select-option-main">
            <span className="mozi-select-option-label">{o.label}</span>
            {o.hint ? <span className="mozi-select-option-hint">{o.hint}</span> : null}
          </span>
          {o.sub ? <span className="mozi-select-option-sub">{o.sub}</span> : null}
        </button>,
      );
    }
    return out;
  };

  return (
    <div
      className={`mozi-select${disabled ? ' disabled' : ''}${open ? ' open' : ''}${alignRight ? ' align-right' : ''}`}
      ref={rootRef}
      style={{ ...(minWidth ? { minWidth } : {}), ...style }}
    >
      <button
        type="button"
        className="mozi-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen(!open);
        }}
      >
        <span className={`mozi-select-label${current ? '' : ' placeholder'}`}>{triggerLabel}</span>
        <span className="mozi-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="mozi-select-menu" role="listbox">
          {options.length === 0 ? (
            <div className="mozi-select-empty">{placeholder ?? '无选项'}</div>
          ) : (
            renderOptions()
          )}
        </div>
      ) : null}
    </div>
  );
}
