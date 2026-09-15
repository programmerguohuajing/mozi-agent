/**
 * 灯箱 — 全屏查看图片（点击缩略图放大；Esc / 点击遮罩 / ✕ 关闭）。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface LightboxProps {
  /** 图片 src（data URL 或 file URL）。 */
  src: string;
  /** 无障碍描述 / 悬浮标题。 */
  alt?: string;
  onClose: () => void;
}

export function Lightbox(props: LightboxProps): React.ReactElement {
  const { t } = useApp();

  // Esc 关闭：挂载时监听，卸载时移除。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={props.alt ?? t('chat.image.view')}
      onClick={props.onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        title={t('chat.image.close')}
        aria-label={t('chat.image.close')}
        onClick={props.onClose}
      >
        ✕
      </button>
      {/* 阻止冒泡：点图片本身不关闭，方便右键另存 / 拖拽 */}
      <img
        className="lightbox-img"
        src={props.src}
        alt={props.alt ?? ''}
        title={props.alt ?? ''}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
