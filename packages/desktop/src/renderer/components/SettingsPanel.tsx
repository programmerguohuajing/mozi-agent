/**
 * 设置中心 — Mozi Studio 生产级 UI。
 */
import * as React from 'react';
import type { McpAddRequest, McpServerInfo, ProviderSummary } from '@mozi/protocol';
import type { PolicyMode, PolicyRule } from '@mozi/shared';
import { McpAddForm } from './McpAddForm.js';

export interface SettingsPanelProps {
  providers: ProviderSummary[];
  policyMode: PolicyMode;
  policyRules: PolicyRule[];
  mcpServers: McpServerInfo[];
  sandboxLevel: 0 | 1 | 2 | 3;
  costLimits: { perSessionUsd?: number; perDayUsd?: number };
  onSetProviderKey: (providerId: string, secret: string) => void;
  onTestProvider: (providerId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onSetPolicyMode: (mode: PolicyMode) => void;
  onSetPolicyRules: (rules: PolicyRule[]) => void;
  onSetSandboxLevel: (level: 0 | 1 | 2 | 3) => void;
  onSetCostLimits: (limits: { perSessionUsd?: number; perDayUsd?: number }) => void;
  onMcpAdd: (req: McpAddRequest) => Promise<{ ok: boolean; error?: string }>;
  onMcpRemove: (id: string) => void;
  onMcpRestart: (id: string) => void;
}

const SANDBOX_LABELS: Record<number, string> = {
  0: 'L0 直执行（不推荐）',
  1: 'L1 进程组超时强杀',
  2: 'L2 平台隔离（Seatbelt / Landlock）',
  3: 'L3 Docker 隔离',
};

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const [jsonView, setJsonView] = React.useState(false);
  const [rulesJson, setRulesJson] = React.useState(JSON.stringify(props.policyRules, null, 2));
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const [keyDraft, setKeyDraft] = React.useState<Record<string, string>>({});

  // MCP 新增表单开关
  const [showMcpForm, setShowMcpForm] = React.useState(false);

  return (
    <div className="settings">
      <div className="settings-title">设置</div>

      <div className="setting-section">
        <div className="setting-section-title"><span>🔌</span> 模型 / Provider</div>
        {props.providers.map((p) => (
          <div key={p.id} className="provider-card">
            <div className="provider-top">
              <span className="provider-id">{p.id}</span>
              <span className="provider-model">{p.model}</span>
              <span className={`provider-status ${p.hasApiKey ? 'configured' : 'not-configured'}`}>
                {p.hasApiKey ? `✓ 已配置 ${p.maskedKey ?? ''}` : '⚠ 未配置密钥'}
              </span>
            </div>
            <div className="input-row-group">
              <input
                type="password"
                className="input-field"
                placeholder="API Key（经 OS 加密存储）"
                value={keyDraft[p.id] ?? ''}
                onChange={(e) => setKeyDraft({ ...keyDraft, [p.id]: e.target.value })}
              />
              <button className="btn-sm" onClick={() => {
                props.onSetProviderKey(p.id, keyDraft[p.id] ?? '');
                setKeyDraft({ ...keyDraft, [p.id]: '' });
              }}>保存</button>
              <button className="btn-sm" onClick={async () => {
                const r = await props.onTestProvider(p.id);
                setTestResult({ ...testResult, [p.id]: r.ok ? `✓ ${r.latencyMs}ms` : `✗ ${r.error}` });
              }}>测试连接</button>
            </div>
            {testResult[p.id] ? (
              <div className={`test-result ${testResult[p.id]!.startsWith('✓') ? 'ok' : 'fail'}`}>
                {testResult[p.id]}
              </div>
            ) : null}
          </div>
        ))}
        {props.providers.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>（尚未添加 provider）</div> : null}
      </div>

      <div className="setting-section">
        <div className="setting-section-title"><span>🛡</span> 策略规则</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <select className="select-field" value={props.policyMode} onChange={(e) => props.onSetPolicyMode(e.target.value as PolicyMode)}>
            <option value="readonly">readonly</option>
            <option value="auto">auto</option>
            <option value="full-auto">full-auto</option>
          </select>
          <button className="btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setJsonView(!jsonView)}>
            {jsonView ? '表格视图' : 'JSON 视图'}
          </button>
        </div>
        {jsonView ? (
          <div>
            <textarea
              style={{ height: 160, width: '100%', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-0)', outline: 'none' }}
              value={rulesJson}
              onChange={(e) => setRulesJson(e.target.value)}
            />
            <button className="btn-sm primary" style={{ marginTop: 8 }} onClick={() => {
              try { props.onSetPolicyRules(JSON.parse(rulesJson)); } catch { /* invalid JSON */ }
            }}>应用</button>
          </div>
        ) : (
          <table className="policy-table">
            <thead>
              <tr><th>ID</th><th>Match</th><th>Action</th></tr>
            </thead>
            <tbody>
              {props.policyRules.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td style={{ color: 'var(--text-2)' }}>{JSON.stringify(r.match)}</td>
                  <td className={r.action === 'allow' ? 'action-allow' : r.action === 'deny' ? 'action-deny' : 'action-ask'}>
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
            className="btn-sm primary"
            style={{ marginLeft: 'auto', fontSize: 12 }}
            onClick={() => setShowMcpForm(!showMcpForm)}
          >
            {showMcpForm ? '取消' : '+ 添加 MCP'}
          </button>
        </div>

        {showMcpForm ? (
          <McpAddForm onSubmit={props.onMcpAdd} onCancel={() => setShowMcpForm(false)} />
        ) : null}

        {props.mcpServers.map((m) => (
          <div key={m.id} className="mcp-card">
            <span className="mcp-id">{m.id}</span>
            <span className="mcp-transport">{m.transport}</span>
            <span className={`mcp-status ${m.status}`}>
              <span className={`status-dot ${m.status === 'connected' ? 'running' : m.status === 'offline' ? 'failed' : 'pending'}`} style={{ width: 6, height: 6 }}></span>
              {m.status}
            </span>
            <span className="mcp-tools">{m.toolCount} tools</span>
            <span className="mcp-sampling">sampling: {m.sampling ?? 'ask'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="btn-sm" onClick={() => props.onMcpRestart(m.id)}>重启</button>
              <button className="skill-delete-btn" title="移除" onClick={() => props.onMcpRemove(m.id)}>✕</button>
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
        <div className="setting-section-title"><span>🔒</span> 沙箱级别</div>
        <select className="select-field" style={{ minWidth: 300 }} value={props.sandboxLevel} onChange={(e) => props.onSetSandboxLevel(Number(e.target.value) as 0 | 1 | 2 | 3)}>
          {[0, 1, 2, 3].map((l) => (
            <option key={l} value={l}>{SANDBOX_LABELS[l]}</option>
          ))}
        </select>
      </div>

      <div className="setting-section">
        <div className="setting-section-title"><span>$</span> 成本上限</div>
        <div className="cost-input-group">
          <label className="cost-input-item">
            每会话 $
            <input type="number" placeholder="5.00" value={props.costLimits.perSessionUsd ?? ''}
              onChange={(e) => props.onSetCostLimits({ ...props.costLimits, perSessionUsd: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          <label className="cost-input-item">
            每日 $
            <input type="number" placeholder="20.00" value={props.costLimits.perDayUsd ?? ''}
              onChange={(e) => props.onSetCostLimits({ ...props.costLimits, perDayUsd: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
        </div>
      </div>
    </div>
  );
}
