/**
 * 技能面板 — Mozi Studio 生产级 UI。
 *
 * 功能：
 *   - 展示已安装技能卡片（名称、描述、触发关键词、状态开关）
 *   - 导入自定义技能（通过 IPC 选择文件 / 粘贴 JSON）
 *   - 技能分类筛选
 *   - 启用 / 禁用 / 删除
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

/** 技能元信息（与主进程 SkillStore 对应）。 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** 触发关键词列表。 */
  triggers: string[];
  /** 技能分类。 */
  category: 'builtin' | 'custom' | 'imported';
  /** 是否启用。 */
  enabled: boolean;
  /** 技能来源路径（custom/imported 有值）。 */
  source?: string;
  /** 版本号。 */
  version?: string;
  /** 图标（emoji 或文字）。 */
  icon?: string;
}

export interface SkillPanelProps {
  skills: SkillInfo[];
  onToggle: (skillId: string) => void;
  onImport: (filePath: string) => void;
  onImportJson: (json: string) => void;
  onDelete: (skillId: string) => void;
}

const CATEGORY_LABELS: Record<SkillInfo['category'], string> = {
  builtin: 'builtin',
  custom: 'custom',
  imported: 'imported',
};

const CATEGORY_ICONS: Record<SkillInfo['category'], string> = {
  builtin: '⚙️',
  custom: '🛠️',
  imported: '📥',
};

export function SkillPanel(props: SkillPanelProps): React.ReactElement {
  const { t } = useApp();
  const [filter, setFilter] = React.useState<SkillInfo['category'] | 'all'>('all');
  const [showImport, setShowImport] = React.useState(false);
  const [importJson, setImportJson] = React.useState('');
  const [importError, setImportError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');

  const filtered = props.skills.filter((s) => {
    if (filter !== 'all' && s.category !== filter) return false;
    if (
      search &&
      !s.name.toLowerCase().includes(search.toLowerCase()) &&
      !s.description.toLowerCase().includes(search.toLowerCase()) &&
      !s.triggers.some((tr) => tr.toLowerCase().includes(search.toLowerCase()))
    )
      return false;
    return true;
  });

  const byCategory = filtered.reduce<Record<string, SkillInfo[]>>((acc, s) => {
    const key = s.category;
    const list = acc[key];
    if (list) {
      list.push(s);
    } else {
      acc[key] = [s];
    }
    return acc;
  }, {});

  const handleImport = (): void => {
    try {
      JSON.parse(importJson); // validate
      props.onImportJson(importJson);
      setImportJson('');
      setShowImport(false);
      setImportError(null);
    } catch {
      setImportError(t('skills.import.error'));
    }
  };

  return (
    <div className="skills-page">
      <div className="skills-header">
        <div>
          <div className="skills-title">{t('skills.title')}</div>
          <div className="skills-subtitle">{t('skills.subtitle')}</div>
        </div>
        <div className="skills-actions">
          <button className="btn-sm" onClick={() => setShowImport(!showImport)}>
            {showImport ? t('skills.import.cancel') : t('skills.import')}
          </button>
        </div>
      </div>

      {/* 导入区域 */}
      {showImport ? (
        <div className="skill-import-area">
          <div className="skill-import-title">{t('skills.import.title')}</div>
          <div className="skill-import-hint">{t('skills.import.hint')}</div>
          <div className="skill-import-row">
            <input
              className="input-field"
              placeholder={t('skills.import.pathPlaceholder')}
              onChange={(e) => {
                if (e.target.value.trim()) {
                  props.onImport(e.target.value.trim());
                  setShowImport(false);
                }
              }}
            />
          </div>
          <div className="skill-import-divider">{t('skills.import.jsonPlaceholder')}</div>
          <textarea
            className="skill-import-textarea"
            placeholder={
              '{\n  "name": "my-skill",\n  "description": "技能描述",\n  "triggers": ["关键词1"],\n  ...\n}'
            }
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
          />
          {importError ? <div className="skill-import-error">{importError}</div> : null}
          <button className="btn-sm primary" style={{ marginTop: 8 }} onClick={handleImport}>
            {t('skills.import.confirm')}
          </button>
        </div>
      ) : null}

      {/* 搜索 + 筛选 */}
      <div className="skills-toolbar">
        <input
          className="input-field skills-search"
          placeholder={t('skills.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="skills-filter-group">
          {(['all', 'builtin', 'custom', 'imported'] as const).map((cat) => (
            <button
              key={cat}
              className={`skill-filter-btn ${filter === cat ? 'active' : ''}`}
              onClick={() => setFilter(cat)}
            >
              {cat === 'all' ? t('skills.filter.all') : catLabels[cat]}
            </button>
          ))}
        </div>
      </div>

      {/* 统计 */}
      <div className="skill-stats">
        <div className="skill-stat">
          <span className="skill-stat-value">{props.skills.length}</span>
          <span className="skill-stat-label">总数</span>
        </div>
        <div className="skill-stat">
          <span className="skill-stat-value">{props.skills.filter((s) => s.enabled).length}</span>
          <span className="skill-stat-label">已启用</span>
        </div>
        <div className="skill-stat">
          <span className="skill-stat-value">
            {
              props.skills.filter((s) => s.category === 'custom' || s.category === 'imported')
                .length
            }
          </span>
          <span className="skill-stat-label">自定义</span>
        </div>
      </div>

      {/* 技能卡片列表 */}
      <div className="skill-grid">
        {filtered.length === 0 ? (
          <div className="skill-empty">
            <div className="empty-state-icon">🧩</div>
            <div className="empty-state-text">
              {search || filter !== 'all' ? t('skills.empty.noMatch') : t('skills.empty.title')}
            </div>
            <div className="empty-state-hint">{t('skills.empty.hint')}</div>
          </div>
        ) : (
          Object.entries(byCategory).map(([cat, skills]) => (
            <div key={cat} className="skill-category-group">
              <div className="skill-category-title">
                <span>{CATEGORY_ICONS[cat as SkillInfo['category']]}</span>
                {catLabels[cat as SkillInfo['category']]}
                <span className="skill-category-count">{skills.length}</span>
              </div>
              <div className="skill-cards">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    className={`skill-card ${skill.enabled ? 'enabled' : 'disabled'}`}
                  >
                    <div className="skill-card-top">
                      <div className="skill-card-icon">{skill.icon ?? '🧩'}</div>
                      <div className="skill-card-info">
                        <div className="skill-card-name">
                          {skill.name}
                          {skill.version ? (
                            <span className="skill-card-version">v{skill.version}</span>
                          ) : null}
                        </div>
                        <div className="skill-card-desc">{skill.description}</div>
                      </div>
                      <label className="skill-toggle">
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={() => props.onToggle(skill.id)}
                        />
                        <span className="skill-toggle-slider" />
                      </label>
                    </div>
                    <div className="skill-card-bottom">
                      <div className="skill-triggers">
                        {skill.triggers.map((t) => (
                          <span key={t} className="skill-trigger-tag">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="skill-card-actions">
                        {skill.source ? (
                          <span className="skill-source" title={skill.source}>
                            {skill.source}
                          </span>
                        ) : null}
                        {skill.category === 'custom' || skill.category === 'imported' ? (
                          <button
                            className="skill-delete-btn"
                            title="删除技能"
                            onClick={() => props.onDelete(skill.id)}
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
