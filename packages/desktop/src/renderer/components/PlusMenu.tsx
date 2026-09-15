import type { McpServerInfo, SkillSummary } from '@mozi/protocol';
/**
 * 输入栏「+」菜单 — 仿 Claude 桌面端的功能面板。
 *
 * 分组：
 *   添加    ：选择项目文件夹 / 引用文件（@）/ 计划模式（开关）
 *   技能    ：本地技能（~/.mozi/skills + 项目 .mozi/skills + 内置），可勾选
 *   MCP 服务：已配置的 MCP server，可勾选
 *
 * 勾选类项不关闭菜单（可连续多选）；动作类项点击后关闭。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface PlusMenuProps {
  /** 当前项目文件夹名（未显式选择时为 undefined，菜单显示引导文案）。 */
  workspaceLabel?: string;
  planMode: boolean;
  onTogglePlan: () => void;
  /** 打开原生目录选择框，为本任务更换项目文件夹。 */
  onPickWorkspace: () => void;
  /** 在输入框插入 `@` 并聚焦（触发文件引用弹层）。 */
  onInsertMention: () => void;
  skills: SkillSummary[];
  selectedSkills: string[];
  onToggleSkill: (id: string) => void;
  mcpServers: McpServerInfo[];
  selectedMcp: string[];
  onToggleMcp: (id: string) => void;
}

export function PlusMenu(props: PlusMenuProps): React.ReactElement {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // 点击外部 / Esc 关闭。
  React.useEffect(() => {
    if (!open) return;
    const onDocDown = (e: Event): void => {
      const target = e.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) setOpen(false);
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

  const skillSet = new Set(props.selectedSkills);
  const mcpSet = new Set(props.selectedMcp);
  const skillCount = props.skills.length;
  const mcpCount = props.mcpServers.length;

  const close = (): void => setOpen(false);

  return (
    <div className="plus-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn-plus${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('chat.plus.title')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M7 2v10M2 7h10" />
        </svg>
      </button>

      {open ? (
        <div className="plus-menu-pop" role="menu" aria-label={t('chat.plus.title')}>
          {/* ── 添加 ── */}
          <div className="plus-menu-group-title">{t('chat.plus.group.add')}</div>
          <button
            type="button"
            role="menuitem"
            className="plus-menu-item"
            onClick={() => {
              props.onPickWorkspace();
              close();
            }}
          >
            <span className="plus-menu-icon" aria-hidden="true">
              📁
            </span>
            <span className="plus-menu-text">
              <span className="plus-menu-item-title">{t('chat.plus.workspace')}</span>
              <span className="plus-menu-item-desc">
                {props.workspaceLabel
                  ? `${t('chat.plus.workspace.current')}: ${props.workspaceLabel}`
                  : t('chat.plus.workspace.unset')}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="plus-menu-item"
            onClick={() => {
              props.onInsertMention();
              close();
            }}
          >
            <span className="plus-menu-icon" aria-hidden="true">
              📎
            </span>
            <span className="plus-menu-text">
              <span className="plus-menu-item-title">{t('chat.plus.mention')}</span>
              <span className="plus-menu-item-desc">{t('chat.plus.mention.desc')}</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.planMode}
            className={`plus-menu-item${props.planMode ? ' checked' : ''}`}
            onClick={() => props.onTogglePlan()}
          >
            <span className="plus-menu-icon" aria-hidden="true">
              💡
            </span>
            <span className="plus-menu-text">
              <span className="plus-menu-item-title">{t('chat.plus.plan')}</span>
              <span className="plus-menu-item-desc">{t('chat.plus.plan.desc')}</span>
            </span>
            <span className="plus-menu-check" aria-hidden="true">
              {props.planMode ? '✓' : ''}
            </span>
          </button>

          {/* ── 技能 ── */}
          {skillCount > 0 ? (
            <>
              <div className="plus-menu-sep" />
              <div className="plus-menu-group-title">
                {t('chat.plus.group.skills')} ({skillCount})
              </div>
              <div className="plus-menu-list">
                {props.skills.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    role="menuitemcheckbox"
                    aria-checked={skillSet.has(s.id)}
                    className={`plus-menu-item${skillSet.has(s.id) ? ' checked' : ''}`}
                    onClick={() => props.onToggleSkill(s.id)}
                  >
                    <span className="plus-menu-icon" aria-hidden="true">
                      {s.icon ?? '🧩'}
                    </span>
                    <span className="plus-menu-text">
                      <span className="plus-menu-item-title">{s.name}</span>
                      <span className="plus-menu-item-desc">{s.description}</span>
                    </span>
                    <span className="plus-menu-check" aria-hidden="true">
                      {skillSet.has(s.id) ? '✓' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {/* ── MCP 服务 ── */}
          {mcpCount > 0 ? (
            <>
              <div className="plus-menu-sep" />
              <div className="plus-menu-group-title">
                {t('chat.plus.group.mcp')} ({mcpCount})
              </div>
              <div className="plus-menu-list">
                {props.mcpServers.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    role="menuitemcheckbox"
                    aria-checked={mcpSet.has(m.id)}
                    className={`plus-menu-item${mcpSet.has(m.id) ? ' checked' : ''}`}
                    onClick={() => props.onToggleMcp(m.id)}
                  >
                    <span className="plus-menu-icon" aria-hidden="true">
                      🔗
                    </span>
                    <span className="plus-menu-text">
                      <span className="plus-menu-item-title">{m.id}</span>
                      <span className="plus-menu-item-desc">
                        {m.toolCount > 0 ? `${m.toolCount} ${t('plugins.mcp.tools')}` : m.transport}
                      </span>
                    </span>
                    <span className="plus-menu-check" aria-hidden="true">
                      {mcpSet.has(m.id) ? '✓' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
