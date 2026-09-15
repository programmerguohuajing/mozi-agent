import type { McpServerInfo, SkillSummary, WorkspaceEntry } from '@mozi/protocol';
import type { PolicyMode } from '@mozi/shared';
/**
 * 输入栏 — 会话底部的消息输入区（从 App.tsx 抽出）。
 *
 * 能力：
 *   - 工作区提示条：未选择项目文件夹时高亮引导（点击 + 菜单 / 此处按钮均可选择）
 *   - @ 引用：输入 `@` 弹出文件/文件夹浏览与全局搜索（workspace:listEntries），
 *     ↑↓ 选择、Enter/Tab 插入、Esc 关闭；发送时展开为绝对路径清单
 *   - 「+」菜单：选择项目文件夹 / 引用文件 / 计划模式 / 技能 / MCP 服务
 *   - 截图标注 / 权限模式 / 发送 / 中止
 */
import * as React from 'react';
import { buildTextWithMentions, detectMention, insertMention } from '../../shared/mentions.js';
import type { MoziApi } from '../App.js';
import { useApp } from '../i18n.js';
import { PermissionMenu } from './PermissionMenu.js';
import { PlusMenu } from './PlusMenu.js';

export interface InputBarProps {
  api: MoziApi;
  sessionId: string;
  /** 当前 workspace 绝对路径。 */
  workspaceRoot?: string;
  /** 项目名（workspace 末段）。 */
  workspaceLabel?: string;
  /** 新建任务后尚未显式选择项目文件夹（提示条高亮引导）。 */
  workspaceUnset: boolean;
  /** 打开原生目录选择框并应用到本任务。 */
  onPickWorkspace: () => void;
  input: string;
  setInput: (v: string) => void;
  /** 发送（finalText 已附加 @ 引用清单）。 */
  send: (finalText: string) => void;
  aborting: boolean;
  canAbort: boolean;
  abort: () => void;
  attachments: Array<{ contentId: string; base64: string; thumbnail: string }>;
  removeAttachment: (contentId: string) => void;
  captureAndAnnotate: () => void;
  captureError: string | null;
  dismissCaptureError: () => void;
  abortError: string | null;
  dismissAbortError: () => void;
  policyMode: PolicyMode;
  onPolicyModeChange: (m: PolicyMode) => void;
  planMode: boolean;
  onPlanModeChange: (v: boolean) => void;
  /** 浏览器面板是否打开（截图按钮仅在打开时显示）。 */
  browserOpen: boolean;
  /** 打开 / 关闭浏览器面板（右侧分栏内嵌 webview）。 */
  onToggleBrowser: () => void;
  skills: SkillSummary[];
  selectedSkills: string[];
  onToggleSkill: (id: string) => void;
  mcpServers: McpServerInfo[];
  selectedMcp: string[];
  onToggleMcp: (id: string) => void;
}

/** @ 弹层的条目请求（dir 浏览 / query 搜索二选一）。 */
interface MentionQuery {
  dir: string;
  query: string;
  filter: string;
}

/** 从 mention query 解析请求：含 `/` 视为目录浏览，否则全局搜索。 */
function resolveMentionQuery(query: string): MentionQuery {
  const slash = query.lastIndexOf('/');
  if (slash >= 0) {
    return { dir: query.slice(0, slash), query: '', filter: query.slice(slash + 1) };
  }
  return { dir: '', query, filter: '' };
}

export function InputBar(props: InputBarProps): React.ReactElement {
  const { t } = useApp();
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  // 光标位置（onChange/onKeyUp/select 时同步；React 受控组件不自动跟踪）。
  const caretRef = React.useRef(0);
  // 当前激活的 mention（@ 的下标 + 查询串）。
  const [mention, setMention] = React.useState<{ start: number; query: string } | null>(null);
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([]);
  const [mentionLoading, setMentionLoading] = React.useState(false);
  const [mentionError, setMentionError] = React.useState<string | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  // mention 类型缓存（relPath → isDir）：发送展开引用清单时标注「文件夹」。
  // 非 null 断言：本仓 renderer tsconfig 下 useRef 泛型解析为可能为 null，
  // 但 React 运行时保证 ref.current 初始化即为传入值。
  const mentionKindsRef = React.useRef<Map<string, boolean>>(new Map());
  const mentionKinds: Map<string, boolean> = mentionKindsRef.current as Map<string, boolean>;

  // textarea 随内容增高（1 行起步，最多 120px）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: props.input 是内容变化的重算触发信号（高度读取自 DOM，词法上未引用），属有意依赖。
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 120)}px`;
    return undefined;
  }, [props.input]);

  // 光标变化时检测 @ mention，触发弹层（普通函数：本仓 renderer tsconfig 下
  // React.useCallback 类型解析异常，且该函数无重渲染依赖问题）。
  const syncMention = (text: string, caret: number): void => {
    const found = detectMention(text, caret);
    setMention(found);
    if (found) {
      setActiveIndex(0);
    }
  };

  // 弹层数据加载（防抖 150ms；dir 浏览 / query 搜索）。
  React.useEffect(() => {
    if (!mention) {
      setEntries([]);
      setMentionError(null);
      return;
    }
    const { dir, query } = resolveMentionQuery(mention.query);
    const timer = setTimeout(() => {
      setMentionLoading(true);
      void props.api
        .invoke('workspace:listEntries', {
          sessionId: props.sessionId,
          dir,
          query: query || undefined,
        })
        .then((r) => {
          const res = r as { ok: boolean; entries?: WorkspaceEntry[]; error?: string };
          if (!res.ok) {
            setEntries([]);
            setMentionError(res.error ?? t('chat.mention.empty'));
            return;
          }
          setEntries(res.entries ?? []);
          setMentionError(null);
          setActiveIndex(0);
        })
        .catch(() => {
          setEntries([]);
          setMentionError(t('chat.mention.empty'));
        })
        .finally(() => setMentionLoading(false));
    }, 150);
    return () => clearTimeout(timer);
  }, [mention, props.sessionId, t, props.api]);

  // 渲染用条目：目录浏览模式下按 filter 前缀过滤。
  const visibleEntries = React.useMemo(() => {
    if (!mention) return [];
    const { filter } = resolveMentionQuery(mention.query);
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(f));
  }, [entries, mention]);

  /** 插入选中的 mention 条目。 */
  const applyMention = (entry: WorkspaceEntry): void => {
    if (!mention) return;
    const { text, caret } = insertMention(
      props.input,
      caretRef.current ?? 0,
      mention.start,
      entry.path,
    );
    mentionKinds.set(entry.path, entry.isDir);
    props.setInput(text);
    setMention(null);
    // 受控组件需要等 React 提交后再恢复光标。
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      caretRef.current = caret;
    });
  };

  /** 在文本末尾插入 `@`（+ 菜单「引用文件」入口）。 */
  const insertAtMention = (): void => {
    const base = props.input;
    const lead = base.length === 0 || /\s$/.test(base) ? '' : ' ';
    const text = `${base}${lead}@`;
    props.setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const caret = text.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      caretRef.current = caret;
      setMention({ start: caret - 1, query: '' });
    });
  };

  const send = (): void => {
    const finalText = props.workspaceRoot
      ? buildTextWithMentions(props.input, props.workspaceRoot, (rel) => mentionKinds.get(rel))
      : props.input;
    setMention(null);
    props.send(finalText);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && visibleEntries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % visibleEntries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + visibleEntries.length) % visibleEntries.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const picked = visibleEntries[activeIndex];
        if (picked) applyMention(picked);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (props.input.trim()) send();
    }
  };

  return (
    <div className="input-bar">
      {/* 工作区提示条：新建任务未选文件夹时引导；已选择显示项目名 */}
      <div className={`workspace-chip${props.workspaceUnset ? ' warn' : ''}`}>
        {props.workspaceUnset ? (
          <>
            <span className="workspace-chip-icon" aria-hidden="true">
              ⚠️
            </span>
            <span className="workspace-chip-text">{t('chat.workspace.unset')}</span>
            <button type="button" className="workspace-chip-btn" onClick={props.onPickWorkspace}>
              {t('chat.workspace.pickNow')}
            </button>
          </>
        ) : (
          <>
            <span className="workspace-chip-icon" aria-hidden="true">
              📁
            </span>
            <span className="workspace-chip-text" title={props.workspaceRoot}>
              {props.workspaceLabel ?? t('chat.workspace.none')}
            </span>
            <button type="button" className="workspace-chip-btn" onClick={props.onPickWorkspace}>
              {t('chat.workspace.change')}
            </button>
          </>
        )}
      </div>

      {props.captureError ? (
        <div className="input-error" role="alert">
          <span className="input-error-text">
            {t('chat.screenshot.failed')}：{props.captureError}
          </span>
          <button
            className="input-error-close"
            onClick={props.dismissCaptureError}
            aria-label={t('chat.screenshot.dismiss')}
          >
            ✕
          </button>
        </div>
      ) : null}

      {props.attachments.length > 0 ? (
        <div className="input-attachments">
          {props.attachments.map((a) => (
            <div key={a.contentId} className="attachment-thumb">
              <img src={`data:image/png;base64,${a.base64}`} alt="screenshot" />
              <button
                className="attachment-remove"
                onClick={() => props.removeAttachment(a.contentId)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="input-row input-row-wrap">
        {/* @ 引用弹层：绝对定位于输入栏上方 */}
        {mention ? (
          <div className="mention-pop" role="listbox" aria-label={t('chat.mention.title')}>
            <div className="mention-pop-head">
              <span className="mention-pop-title">{t('chat.mention.title')}</span>
              <span className="mention-pop-hint">{t('chat.mention.hint')}</span>
            </div>
            {mentionLoading ? (
              <div className="mention-empty">{t('chat.mention.searching')}</div>
            ) : mentionError ? (
              <div className="mention-empty">{mentionError}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="mention-empty">{t('chat.mention.empty')}</div>
            ) : (
              <div className="mention-list">
                {visibleEntries.map((entry, i) => (
                  <button
                    type="button"
                    key={entry.path}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`mention-item${i === activeIndex ? ' active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      applyMention(entry);
                    }}
                  >
                    <span className={`mention-icon${entry.isDir ? ' dir' : ''}`} aria-hidden="true">
                      {entry.isDir ? '📁' : '📄'}
                    </span>
                    <span className="mention-name">{entry.name}</span>
                    <span className="mention-path">{entry.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <PlusMenu
          workspaceLabel={props.workspaceLabel}
          planMode={props.planMode}
          onTogglePlan={() => props.onPlanModeChange(!props.planMode)}
          onPickWorkspace={props.onPickWorkspace}
          onInsertMention={insertAtMention}
          skills={props.skills}
          selectedSkills={props.selectedSkills}
          onToggleSkill={props.onToggleSkill}
          mcpServers={props.mcpServers}
          selectedMcp={props.selectedMcp}
          onToggleMcp={props.onToggleMcp}
        />

        <textarea
          ref={inputRef}
          rows={1}
          className="input-textarea"
          placeholder={t('chat.input.placeholder')}
          value={props.input}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            caretRef.current = e.target.selectionStart ?? e.target.value.length;
            props.setInput(e.target.value);
            syncMention(e.target.value, caretRef.current);
          }}
          onKeyUp={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            // 方向键移动光标也要重新检测（onchange 不触发）。
            if (
              e.key === 'ArrowLeft' ||
              e.key === 'ArrowRight' ||
              e.key === 'Home' ||
              e.key === 'End'
            ) {
              caretRef.current = e.currentTarget.selectionStart ?? 0;
              syncMention(e.currentTarget.value, caretRef.current);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // 延迟关闭：给 onMouseDown 插入留出时间。
            setTimeout(() => setMention(null), 120);
          }}
        />

        {/* 浏览器开关：打开右侧内嵌浏览器面板（agent 的 browser 工具操作同一页面） */}
        <button
          type="button"
          className={`btn-tool btn-browser${props.browserOpen ? ' active' : ''}`}
          title={props.browserOpen ? t('chat.browser.close') : t('chat.browser.open')}
          aria-pressed={props.browserOpen}
          onClick={props.onToggleBrowser}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6.2" />
            <path d="M1.8 8h12.4" />
            <path d="M8 1.8c-2.2 2-3.3 4-3.3 6.2s1.1 4.2 3.3 6.2c2.2-2 3.3-4 3.3-6.2s-1.1-4.2-3.3-6.2z" />
          </svg>
          {t('chat.browser')}
        </button>

        {/* 截图：仅在浏览器面板打开时显示（截取 webview 当前页面 → 标注 → 附件） */}
        {props.browserOpen ? (
          <button
            className="btn-tool"
            title={t('chat.screenshot.hint')}
            aria-label={t('chat.screenshot.hint')}
            onClick={() => props.captureAndAnnotate()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.6 6.4A1.6 1.6 0 0 1 4.2 4.9h1.3l0.9 -1.6h3.2l0.9 1.6h1.3a1.6 1.6 0 0 1 1.6 1.5v5.4a1.6 1.6 0 0 1 -1.6 1.6H4.2a1.6 1.6 0 0 1 -1.6 -1.6z" />
              <circle cx="8" cy="9.2" r="2.3" />
            </svg>
            {t('chat.screenshot')}
          </button>
        ) : null}

        <PermissionMenu mode={props.policyMode} onSelect={props.onPolicyModeChange} />

        {props.planMode ? (
          <button
            type="button"
            className="plan-badge"
            title={t('chat.plan.badge.desc')}
            onClick={() => props.onPlanModeChange(false)}
          >
            {t('chat.plan.badge')}
          </button>
        ) : null}

        <button
          className="btn-send"
          onClick={() => {
            if (props.input.trim()) send();
          }}
        >
          {t('chat.send')}
        </button>
        <button
          className="btn-abort"
          disabled={props.aborting || !props.canAbort}
          title={props.canAbort ? t('chat.abort') : t('chat.abort.idleHint')}
          onClick={() => props.abort()}
        >
          {props.aborting ? t('chat.abort.pending') : t('chat.abort')}
        </button>
      </div>

      {props.abortError ? (
        <div className="input-error">
          <span>{props.abortError}</span>
          <button
            className="input-error-close"
            onClick={props.dismissAbortError}
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
