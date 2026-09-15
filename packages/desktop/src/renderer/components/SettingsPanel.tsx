import type {
  ApiFormat,
  McpAddRequest,
  McpServerInfo,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderSummary,
} from '@mozi/protocol';
import type { PolicyMode, PolicyRule } from '@mozi/shared';
/**
 * 设置中心 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import { McpAddForm } from './McpAddForm.js';
import { Select, type SelectOption } from './Select.js';

export type CloseBehavior = 'quit' | 'tray';

/** 状态 setter（结构化声明：本仓 renderer tsconfig 下 React.Dispatch 类型解析异常）。 */
export type ModelSelectionSetter = (
  updater: (prev: Record<string, boolean>) => Record<string, boolean>,
) => void;

export interface AddProviderRequest {
  id: string;
  model: string;
  /** 该提供商接入的模型列表（多模型；空 = 网关自动路由）。 */
  models?: string[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  modelMap?: Record<string, string>;
}

export interface UpdateProviderRequest {
  id: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  modelMap?: Record<string, string>;
}

export interface SettingsPanelProps {
  providers: ProviderSummary[];
  policyMode: PolicyMode;
  policyRules: PolicyRule[];
  mcpServers: McpServerInfo[];
  sandboxLevel: 0 | 1 | 2 | 3;
  costLimits: { perSessionUsd?: number; perDayUsd?: number };
  /** 基础设置：关闭主窗口时的行为（直接退出 / 最小化到托盘常驻）。 */
  closeBehavior: CloseBehavior;
  onSetCloseBehavior: (behavior: CloseBehavior) => void;
  onSetProviderKey: (providerId: string, secret: string) => void;
  onTestProvider: (
    providerId: string,
  ) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onAddProvider: (req: AddProviderRequest) => Promise<{ ok: boolean; error?: string }>;
  onRemoveProvider: (providerId: string) => void;
  onUpdateProvider: (req: UpdateProviderRequest) => Promise<{ ok: boolean; error?: string }>;
  onSetPolicyMode: (mode: PolicyMode) => void;
  onSetPolicyRules: (rules: PolicyRule[]) => void;
  onSetSandboxLevel: (level: 0 | 1 | 2 | 3) => void;
  onSetCostLimits: (limits: { perSessionUsd?: number; perDayUsd?: number }) => void;
  /** 拉取 baseUrl 端点下的模型列表（模型勾选数据源，§10.5④）。 */
  onFetchModels: (req: ProviderModelsRequest) => Promise<ProviderModelsResponse>;
  onMcpAdd: (req: McpAddRequest) => Promise<{ ok: boolean; error?: string }>;
  onMcpRemove: (id: string) => void;
  onMcpRestart: (id: string) => void;
  /** 读取完整 MCP 配置（JSON 编辑器数据源）。 */
  onMcpGetConfig: () => Promise<{ ok: boolean; servers?: McpAddRequest[]; error?: string }>;
  /** 校验并整体替换 MCP 配置（JSON 编辑器保存）。 */
  onMcpSetConfig: (servers: McpAddRequest[]) => Promise<{
    ok: boolean;
    errors?: Array<{ index: number; error: string }>;
    error?: string;
  }>;
}

const SANDBOX_LABELS: Record<number, string> = {
  0: 'L0 直执行（不推荐）',
  1: 'L1 进程组超时强杀',
  2: 'L2 平台隔离（Seatbelt / Landlock）',
  3: 'L3 Docker 隔离',
};

const CLOSE_BEHAVIOR_LABELS: Record<CloseBehavior, string> = {
  quit: '直接退出',
  tray: '最小化到系统托盘（后台常驻）',
};

/** 上游 API 格式选项（§10.5④）。 */
const API_FORMAT_OPTIONS: Array<{
  value: ApiFormat;
  label: string;
  placeholder: string;
  hint: string;
}> = [
  {
    value: 'openai',
    label: 'OpenAI Chat Completions',
    placeholder: 'https://api.deepseek.com/v1（含 /v1 版本段）',
    hint: '含 /v1',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses API',
    placeholder: 'https://api.openai.com（不含版本段）',
    hint: '不含 /v1',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    placeholder: 'https://api.anthropic.com（不含版本段）',
    hint: '不含 /v1',
  },
  {
    value: 'gemini',
    label: 'Gemini generateContent',
    placeholder: 'https://generativelanguage.googleapis.com（不含版本段）',
    hint: '不含 /v1',
  },
];

/** 上游格式下拉选项（自定义 Select 数据源）。 */
const apiFormatSelectOptions: SelectOption[] = API_FORMAT_OPTIONS.map((f) => ({
  value: f.value,
  label: f.label,
  hint: f.hint,
}));

/** 模型勾选列表（获取到的模型 → 勾选状态）。 */
function ModelCheckList(props: {
  models: string[];
  selected: Record<string, boolean>;
  onToggle: (m: string, checked: boolean) => void;
}): React.ReactElement | null {
  if (props.models.length === 0) return null;
  return (
    <div
      style={{
        maxHeight: 200,
        overflowY: 'auto',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 6,
      }}
    >
      {props.models.map((m) => (
        <label
          key={m}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '3px 4px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={Boolean(props.selected[m])}
            onChange={(e) => props.onToggle(m, e.target.checked)}
          />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{m}</span>
        </label>
      ))}
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const [jsonView, setJsonView] = React.useState(false);
  const [rulesJson, setRulesJson] = React.useState(JSON.stringify(props.policyRules, null, 2));
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const [keyDraft, setKeyDraft] = React.useState<Record<string, string>>({});

  // MCP 新增表单开关
  const [showMcpForm, setShowMcpForm] = React.useState(false);

  // ── mcp.json JSON 编辑器 ──
  const [showMcpJson, setShowMcpJson] = React.useState(false);
  const [mcpJsonText, setMcpJsonText] = React.useState('');
  const [mcpJsonError, setMcpJsonError] = React.useState('');
  const [mcpJsonSaving, setMcpJsonSaving] = React.useState(false);

  const loadMcpJson = async (): Promise<void> => {
    setMcpJsonError('');
    const r = await props.onMcpGetConfig();
    if (!r.ok || !r.servers) {
      setMcpJsonError(r.error ?? '读取配置失败');
      return;
    }
    setMcpJsonText(JSON.stringify(r.servers, null, 2));
  };

  const openMcpJson = async (): Promise<void> => {
    setShowMcpJson(!showMcpJson);
    if (!showMcpJson) await loadMcpJson();
  };

  const saveMcpJson = async (): Promise<void> => {
    setMcpJsonError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpJsonText);
    } catch (e) {
      setMcpJsonError(`JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setMcpJsonError('配置必须是数组（每项一个 server 对象）');
      return;
    }
    setMcpJsonSaving(true);
    try {
      const r = await props.onMcpSetConfig(parsed as McpAddRequest[]);
      if (r.ok) {
        setShowMcpJson(false);
      } else if (r.errors && r.errors.length > 0) {
        setMcpJsonError(r.errors.map((e) => `第 ${e.index + 1} 项：${e.error}`).join('；'));
      } else {
        setMcpJsonError(r.error ?? '保存失败');
      }
    } finally {
      setMcpJsonSaving(false);
    }
  };

  // ── 新增 Provider 表单：提供商信息 + 模型多选 ──
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [newId, setNewId] = React.useState('');
  const [newBaseUrl, setNewBaseUrl] = React.useState('');
  const [newApiKey, setNewApiKey] = React.useState('');
  const [newApiFormat, setNewApiFormat] = React.useState<ApiFormat>('openai');
  const [addError, setAddError] = React.useState('');
  /** 勾选的模型（该提供商提供的模型列表；不勾 = 网关自动路由）。 */
  const [newSelectedModels, setNewSelectedModels] = React.useState<Record<string, boolean>>({});
  /** 手动添加的模型名（端点未列出时）。 */
  const [newCustomModel, setNewCustomModel] = React.useState('');

  // 编辑 Provider 状态
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editBaseUrl, setEditBaseUrl] = React.useState('');
  const [editApiKey, setEditApiKey] = React.useState('');
  const [editApiFormat, setEditApiFormat] = React.useState<ApiFormat>('openai');
  const [editError, setEditError] = React.useState('');
  const [editSelectedModels, setEditSelectedModels] = React.useState<Record<string, boolean>>({});
  const [editCustomModel, setEditCustomModel] = React.useState('');

  // ── 模型列表（从 baseUrl 端点拉取，勾选数据源）──
  // key：'__new__' 表示新增表单，否则为 providerId（编辑已保存的 provider）。
  const [modelsByKey, setModelsByKey] = React.useState<Record<string, string[]>>({});
  const [modelsLoading, setModelsLoading] = React.useState<Record<string, boolean>>({});
  const [modelsError, setModelsError] = React.useState<Record<string, string>>({});

  const fetchModels = async (key: string, req: ProviderModelsRequest): Promise<void> => {
    setModelsLoading((p) => ({ ...p, [key]: true }));
    setModelsError((p) => ({ ...p, [key]: '' }));
    const r = await props.onFetchModels(req);
    setModelsLoading((p) => ({ ...p, [key]: false }));
    if (r.ok) {
      setModelsByKey((p) => ({ ...p, [key]: r.models ?? [] }));
    } else {
      setModelsError((p) => ({ ...p, [key]: r.error ?? '获取模型列表失败' }));
    }
  };

  /** 勾选模型 → 有序列表（保持端点返回顺序）。 */
  const selectedModelsOf = (
    key: '__new__' | string,
    selected: Record<string, boolean>,
  ): string[] => {
    const available = modelsByKey[key] ?? [];
    const fromList = available.filter((m) => selected[m]);
    // 手动添加的模型（不在列表中但勾选状态存在——通过 custom 输入加入）
    const extras = Object.keys(selected).filter((m) => !available.includes(m) && selected[m]);
    return [...fromList, ...extras];
  };

  const toggleModel = (setter: ModelSelectionSetter, m: string, checked: boolean): void => {
    setter((p: Record<string, boolean>): Record<string, boolean> => {
      const next = { ...p, [m]: checked };
      if (!checked) delete next[m];
      return next;
    });
  };

  /** 手动添加模型（不在端点列表中时）。 */
  const addCustomModel = (
    setter: ModelSelectionSetter,
    custom: string,
    resetCustom: () => void,
  ): void => {
    const m = custom.trim();
    if (!m) return;
    setter((p: Record<string, boolean>): Record<string, boolean> => ({ ...p, [m]: true }));
    resetCustom();
  };

  const resetAddForm = (): void => {
    setNewId('');
    setNewBaseUrl('');
    setNewApiKey('');
    setNewApiFormat('openai');
    setNewSelectedModels({});
    setNewCustomModel('');
    setAddError('');
  };

  const handleAddProvider = async (): Promise<void> => {
    setAddError('');
    if (!newId.trim()) {
      setAddError('Provider ID 不能为空');
      return;
    }
    const models = selectedModelsOf('__new__', newSelectedModels);
    // 未勾选任何模型 = 自动路由（必须填 Base URL）。
    if (models.length === 0 && !newBaseUrl.trim()) {
      setAddError('请至少勾选一个模型，或填写 Base URL（自动路由）');
      return;
    }
    const result = await props.onAddProvider({
      id: newId.trim(),
      // model 存第一个模型名（默认/测试连接模型；空 = 自动路由）。
      model: models[0] ?? '',
      models,
      baseUrl: newBaseUrl.trim() || undefined,
      apiKey: newApiKey.trim() || undefined,
      apiFormat: newApiFormat,
    });
    if (result.ok) {
      resetAddForm();
      setShowAddForm(false);
    } else {
      setAddError(result.error ?? '添加失败');
    }
  };

  const startEdit = (p: ProviderSummary): void => {
    setEditingId(p.id);
    setEditBaseUrl(p.baseUrl ?? '');
    setEditApiKey('');
    setEditError('');
    setEditApiFormat(p.apiFormat ?? 'openai');
    setEditCustomModel('');
    // 已配置的模型回填为勾选态（models 列表 = 后端返回的可选模型）。
    const configured = p.models ?? [];
    const selected: Record<string, boolean> = {};
    for (const m of configured) selected[m] = true;
    setEditSelectedModels(selected);
    // 编辑时已知模型列表 = 已保存的（拉取后会被端点列表替换/补充）。
    setModelsByKey((prev) => ({ ...prev, [p.id]: configured }));
  };

  const handleUpdateProvider = async (id: string): Promise<void> => {
    setEditError('');
    const models = selectedModelsOf(id, editSelectedModels);
    const baseUrl = editBaseUrl.trim() || undefined;
    if (models.length === 0 && !baseUrl) {
      setEditError('请至少勾选一个模型，或填写 Base URL（自动路由）');
      return;
    }
    const result = await props.onUpdateProvider({
      id,
      model: models[0] ?? '',
      models,
      baseUrl,
      apiKey: editApiKey.trim() || undefined,
      apiFormat: editApiFormat,
    });
    if (result.ok) setEditingId(null);
    else setEditError(result.error ?? '更新失败');
  };

  return (
    <div className="settings">
      <div className="settings-title">设置</div>

      {/* ── 基础设置 ───────────────────────────────────────── */}
      <div className="setting-section">
        <div className="setting-section-title">
          <span>⚙️</span> 基础设置
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--text-1)' }}>关闭主窗口时</span>
          <Select
            style={{ minWidth: 260 }}
            value={props.closeBehavior}
            options={[
              { value: 'quit', label: CLOSE_BEHAVIOR_LABELS.quit },
              { value: 'tray', label: CLOSE_BEHAVIOR_LABELS.tray },
            ]}
            onChange={(v) => props.onSetCloseBehavior(v as CloseBehavior)}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
          {props.closeBehavior === 'tray'
            ? '关闭主窗口后应用在系统托盘常驻，后台任务继续运行；点击托盘图标或「退出 Mozi」可恢复 / 退出。'
            : '关闭主窗口即退出应用，后台任务将终止。'}
        </div>
      </div>

      <div className="setting-section">
        <div className="setting-section-title">
          <span>🔌</span> 模型 / Provider
          <button
            className="btn-sm primary"
            style={{ marginLeft: 'auto', fontSize: 12 }}
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? '取消' : '+ 添加 Provider'}
          </button>
        </div>

        {/* 新增 Provider 表单：提供商信息 + 模型多选勾选 */}
        {showAddForm ? (
          <div className="provider-card" style={{ border: '1px dashed var(--border)' }}>
            <div className="provider-top">
              <span className="provider-id" style={{ color: 'var(--text-2)' }}>
                新增 Provider
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <input
                className="input-field"
                placeholder="Provider ID（如 deepseek、openai）"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
              />

              {/* 上游 API 格式 */}
              <div className="input-row-group">
                <span style={{ fontSize: 13, color: 'var(--text-1)', minWidth: 72 }}>上游格式</span>
                <Select
                  style={{ minWidth: 300 }}
                  value={newApiFormat}
                  options={apiFormatSelectOptions}
                  onChange={(v) => setNewApiFormat(v as ApiFormat)}
                />
              </div>

              <input
                className="input-field"
                placeholder={`Base URL（${API_FORMAT_OPTIONS.find((f) => f.value === newApiFormat)?.placeholder ?? ''}）`}
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
              />
              <div className="input-row-group">
                <input
                  type="password"
                  className="input-field"
                  placeholder="API Key（可选，稍后也可在卡片中配置）"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                />
                <button
                  className="btn-sm"
                  disabled={!newId.trim() || !newBaseUrl.trim() || Boolean(modelsLoading.__new__)}
                  onClick={() =>
                    void fetchModels('__new__', {
                      providerId: newId.trim(),
                      baseUrl: newBaseUrl.trim(),
                      apiKey: newApiKey.trim() || undefined,
                      apiFormat: newApiFormat,
                    })
                  }
                >
                  {modelsLoading.__new__ ? '获取中…' : '获取模型列表'}
                </button>
              </div>
              {modelsError.__new__ ? (
                <div className="test-result fail">{modelsError.__new__}</div>
              ) : null}

              {/* 模型勾选：该提供商提供的模型 */}
              {(modelsByKey.__new__ ?? []).length > 0 ? (
                <ModelCheckList
                  models={modelsByKey.__new__ ?? []}
                  selected={newSelectedModels}
                  onToggle={(m, checked) => toggleModel(setNewSelectedModels, m, checked)}
                />
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  填写 Base URL 后「获取模型列表」，勾选该提供商提供的模型
                </div>
              )}

              {/* 手动添加模型（端点未列出时） */}
              <div className="input-row-group">
                <input
                  className="input-field"
                  style={{ flex: 1 }}
                  placeholder="手动添加模型名（端点未列出时）"
                  value={newCustomModel}
                  onChange={(e) => setNewCustomModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustomModel(setNewSelectedModels, newCustomModel, () =>
                        setNewCustomModel(''),
                      );
                    }
                  }}
                />
                <button
                  className="btn-sm"
                  onClick={() =>
                    addCustomModel(setNewSelectedModels, newCustomModel, () =>
                      setNewCustomModel(''),
                    )
                  }
                >
                  添加
                </button>
              </div>

              {/* 已选模型清单（含手动添加的） */}
              {Object.keys(newSelectedModels).length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {Object.keys(newSelectedModels).map((m) => (
                    <span key={m} className="model-chip">
                      {m}
                      <button
                        type="button"
                        className="model-chip-x"
                        aria-label={`移除 ${m}`}
                        onClick={() => toggleModel(setNewSelectedModels, m, false)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  未勾选任何模型：任务将直接发送到网关，由其自行路由模型（需网关支持）。
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn-sm primary" onClick={() => void handleAddProvider()}>
                  添加
                </button>
              </div>
              {addError ? <div className="test-result fail">{addError}</div> : null}
            </div>
          </div>
        ) : null}

        {/* 已有 Provider 列表 */}
        {props.providers.map((p) => (
          <div key={p.id} className="provider-card">
            {editingId === p.id ? (
              /* ── 编辑模式 ── */
              <>
                <div className="provider-top">
                  <span className="provider-id">{p.id}</span>
                  <span className="provider-model" style={{ color: 'var(--text-2)' }}>
                    编辑中…
                  </span>
                  <button
                    className="btn-sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setEditingId(null)}
                  >
                    取消
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  <div className="input-row-group">
                    <span style={{ fontSize: 13, color: 'var(--text-1)', minWidth: 72 }}>
                      上游格式
                    </span>
                    <Select
                      style={{ minWidth: 300 }}
                      value={editApiFormat}
                      options={apiFormatSelectOptions}
                      onChange={(v) => setEditApiFormat(v as ApiFormat)}
                    />
                  </div>
                  <input
                    className="input-field"
                    placeholder={`Base URL（${API_FORMAT_OPTIONS.find((f) => f.value === editApiFormat)?.placeholder ?? ''}）`}
                    value={editBaseUrl}
                    onChange={(e) => setEditBaseUrl(e.target.value)}
                  />
                  <div className="input-row-group">
                    <input
                      type="password"
                      className="input-field"
                      placeholder="新 API Key（留空则不修改）"
                      value={editApiKey}
                      onChange={(e) => setEditApiKey(e.target.value)}
                    />
                    <button
                      className="btn-sm"
                      disabled={Boolean(modelsLoading[p.id])}
                      onClick={() =>
                        void fetchModels(p.id, {
                          providerId: p.id,
                          baseUrl: editBaseUrl.trim() || undefined,
                          apiKey: editApiKey.trim() || undefined,
                          apiFormat: editApiFormat,
                        })
                      }
                    >
                      {modelsLoading[p.id] ? '获取中…' : '获取模型列表'}
                    </button>
                  </div>
                  {modelsError[p.id] ? (
                    <div className="test-result fail">{modelsError[p.id]}</div>
                  ) : null}

                  {/* 模型勾选 */}
                  {(modelsByKey[p.id] ?? []).length > 0 ? (
                    <ModelCheckList
                      models={modelsByKey[p.id] ?? []}
                      selected={editSelectedModels}
                      onToggle={(m, checked) => toggleModel(setEditSelectedModels, m, checked)}
                    />
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      可「获取模型列表」加载可选模型
                    </div>
                  )}

                  {/* 手动添加模型 */}
                  <div className="input-row-group">
                    <input
                      className="input-field"
                      style={{ flex: 1 }}
                      placeholder="手动添加模型名（端点未列出时）"
                      value={editCustomModel}
                      onChange={(e) => setEditCustomModel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addCustomModel(setEditSelectedModels, editCustomModel, () =>
                            setEditCustomModel(''),
                          );
                        }
                      }}
                    />
                    <button
                      className="btn-sm"
                      onClick={() =>
                        addCustomModel(setEditSelectedModels, editCustomModel, () =>
                          setEditCustomModel(''),
                        )
                      }
                    >
                      添加
                    </button>
                  </div>

                  {/* 已选模型清单 */}
                  {Object.keys(editSelectedModels).length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.keys(editSelectedModels).map((m) => (
                        <span key={m} className="model-chip">
                          {m}
                          <button
                            type="button"
                            className="model-chip-x"
                            aria-label={`移除 ${m}`}
                            onClick={() => toggleModel(setEditSelectedModels, m, false)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      未勾选任何模型：任务将直接发送到网关，由其自行路由模型。
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      className="btn-sm primary"
                      onClick={() => void handleUpdateProvider(p.id)}
                    >
                      保存
                    </button>
                  </div>
                  {editError ? <div className="test-result fail">{editError}</div> : null}
                </div>
              </>
            ) : (
              /* ── 正常展示模式 ── */
              <>
                <div className="provider-top">
                  <span className="provider-id">{p.id}</span>
                  <span className="provider-model">
                    {p.autoRoute
                      ? '自动路由'
                      : (p.models ?? []).length > 0
                        ? `${(p.models ?? []).length} 个模型`
                        : p.model}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {API_FORMAT_OPTIONS.find((f) => f.value === (p.apiFormat ?? 'openai'))?.label}
                  </span>
                  {p.baseUrl ? (
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{p.baseUrl}</span>
                  ) : null}
                  <span
                    className={`provider-status ${p.hasApiKey ? 'configured' : 'not-configured'}`}
                  >
                    {p.hasApiKey ? `✓ 已配置 ${p.maskedKey ?? ''}` : '⚠ 未配置密钥'}
                  </span>
                  <button
                    className="btn-sm"
                    style={{ marginLeft: 'auto' }}
                    title="编辑此 Provider"
                    onClick={() => startEdit(p)}
                  >
                    ✎
                  </button>
                  <button
                    className="btn-sm"
                    style={{ color: 'var(--text-3)' }}
                    title="删除此 Provider"
                    onClick={() => {
                      if (confirm(`确定删除 Provider "${p.id}"？`)) props.onRemoveProvider(p.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {/* 该提供商提供的模型清单（任务窗口模型选择器的数据源） */}
                {!p.autoRoute && (p.models ?? []).length > 1 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {(p.models ?? []).map((m) => (
                      <span key={m} className="model-chip static">
                        {m}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="input-row-group">
                  <input
                    type="password"
                    className="input-field"
                    placeholder="API Key（经 OS 加密存储）"
                    value={keyDraft[p.id] ?? ''}
                    onChange={(e) => setKeyDraft({ ...keyDraft, [p.id]: e.target.value })}
                  />
                  <button
                    className="btn-sm"
                    onClick={() => {
                      props.onSetProviderKey(p.id, keyDraft[p.id] ?? '');
                      setKeyDraft({ ...keyDraft, [p.id]: '' });
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="btn-sm"
                    onClick={async () => {
                      const r = await props.onTestProvider(p.id);
                      setTestResult({
                        ...testResult,
                        [p.id]: r.ok ? `✓ ${r.latencyMs}ms` : `✗ ${r.error}`,
                      });
                    }}
                  >
                    测试连接
                  </button>
                </div>
                {testResult[p.id] ? (
                  <div
                    className={`test-result ${testResult[p.id]?.startsWith('✓') ? 'ok' : 'fail'}`}
                  >
                    {testResult[p.id]}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        {props.providers.length === 0 && !showAddForm ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            （尚未添加 provider，点击上方「+ 添加 Provider」开始）
          </div>
        ) : null}
      </div>

      <div className="setting-section">
        <div className="setting-section-title">
          <span>🛡</span> 策略规则
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <select
            className="select-field"
            value={props.policyMode}
            onChange={(e) => props.onSetPolicyMode(e.target.value as PolicyMode)}
          >
            <option value="readonly">readonly</option>
            <option value="auto">auto</option>
            <option value="full-auto">full-auto</option>
          </select>
          <button
            className="btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => setJsonView(!jsonView)}
          >
            {jsonView ? '表格视图' : 'JSON 视图'}
          </button>
        </div>
        {jsonView ? (
          <div>
            <textarea
              style={{
                height: 160,
                width: '100%',
                background: 'var(--bg-1)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-0)',
                outline: 'none',
              }}
              value={rulesJson}
              onChange={(e) => setRulesJson(e.target.value)}
            />
            <button
              className="btn-sm primary"
              style={{ marginTop: 8 }}
              onClick={() => {
                try {
                  props.onSetPolicyRules(JSON.parse(rulesJson));
                } catch {
                  /* invalid JSON */
                }
              }}
            >
              应用
            </button>
          </div>
        ) : (
          <table className="policy-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Match</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {props.policyRules.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td style={{ color: 'var(--text-2)' }}>{JSON.stringify(r.match)}</td>
                  <td
                    className={
                      r.action === 'allow'
                        ? 'action-allow'
                        : r.action === 'deny'
                          ? 'action-deny'
                          : 'action-ask'
                    }
                  >
                    {r.action}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="setting-section">
        <div className="setting-section-title">
          <span>🔗</span> MCP Server 管理
          <button
            className="btn-sm"
            style={{ marginLeft: 'auto', fontSize: 12 }}
            onClick={() => void openMcpJson()}
          >
            {showMcpJson ? '收起 JSON' : '⌨ 编辑 mcp.json'}
          </button>
          <button
            className="btn-sm primary"
            style={{ fontSize: 12 }}
            onClick={() => setShowMcpForm(!showMcpForm)}
          >
            {showMcpForm ? '取消' : '+ 添加 MCP'}
          </button>
        </div>

        {/* ── JSON 直接编辑器：支持 headers / auth / timeoutMs / cwd 全量字段 ── */}
        {showMcpJson ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              直接编辑完整配置（数组，每项一个 server）。http/sse 支持 headers（如 Authorization）、
              auth、timeoutMs；stdio 支持 env、cwd。保存时逐条校验，全部通过才落盘。
            </div>
            <textarea
              className="input-field"
              style={{
                minHeight: 240,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.6,
                resize: 'vertical',
                whiteSpace: 'pre',
              }}
              spellCheck={false}
              value={mcpJsonText}
              onChange={(e) => setMcpJsonText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-sm" onClick={() => void loadMcpJson()}>
                重新加载
              </button>
              <button className="btn-sm" onClick={() => setShowMcpJson(false)}>
                取消
              </button>
              <button
                className="btn-sm primary"
                disabled={mcpJsonSaving}
                onClick={() => void saveMcpJson()}
              >
                {mcpJsonSaving ? '保存中…' : '校验并保存'}
              </button>
            </div>
            {mcpJsonError ? <div className="test-result fail">{mcpJsonError}</div> : null}
          </div>
        ) : null}

        {showMcpForm ? (
          <McpAddForm onSubmit={props.onMcpAdd} onCancel={() => setShowMcpForm(false)} />
        ) : null}

        {props.mcpServers.map((m) => (
          <div key={m.id} className="mcp-card">
            <span className="mcp-id">{m.id}</span>
            <span className="mcp-transport">{m.transport}</span>
            <span className={`mcp-status ${m.status}`}>
              <span
                className={`status-dot ${m.status === 'connected' ? 'running' : m.status === 'offline' ? 'failed' : 'pending'}`}
                style={{ width: 6, height: 6 }}
              />
              {m.status}
            </span>
            <span className="mcp-tools">{m.toolCount} tools</span>
            <span className="mcp-sampling">sampling: {m.sampling ?? 'ask'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="btn-sm" onClick={() => props.onMcpRestart(m.id)}>
                重启
              </button>
              <button
                className="skill-delete-btn"
                title="移除"
                onClick={() => props.onMcpRemove(m.id)}
              >
                ✕
              </button>
            </span>
          </div>
        ))}
        {props.mcpServers.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            （未配置 MCP server）点击右上角「+ 添加 MCP」接入 stdio / http / sse 服务
          </div>
        ) : null}
      </div>

      <div className="setting-section">
        <div className="setting-section-title">
          <span>🔒</span> 沙箱级别
        </div>
        <select
          className="select-field"
          style={{ minWidth: 300 }}
          value={props.sandboxLevel}
          onChange={(e) => props.onSetSandboxLevel(Number(e.target.value) as 0 | 1 | 2 | 3)}
        >
          {[0, 1, 2, 3].map((l) => (
            <option key={l} value={l}>
              {SANDBOX_LABELS[l]}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-section">
        <div className="setting-section-title">
          <span>$</span> 成本上限
        </div>
        <div className="cost-input-group">
          <label className="cost-input-item">
            每会话 $
            <input
              type="number"
              placeholder="5.00"
              value={props.costLimits.perSessionUsd ?? ''}
              onChange={(e) =>
                props.onSetCostLimits({
                  ...props.costLimits,
                  perSessionUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label className="cost-input-item">
            每日 $
            <input
              type="number"
              placeholder="20.00"
              value={props.costLimits.perDayUsd ?? ''}
              onChange={(e) =>
                props.onSetCostLimits({
                  ...props.costLimits,
                  perDayUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
        </div>
      </div>
    </div>
  );
}
