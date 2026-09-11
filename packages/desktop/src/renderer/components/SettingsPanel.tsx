/**
 * 设置中心（M10 §10.5④）：模型/Provider 管理、策略规则编辑器（表格 + JSON 双视图）、
 * MCP Server 管理、沙箱级别、成本上限。
 *
 * 安全：密钥字段只显示脱敏预览；输入后经 `config:set` → 主进程 safeStorage 加密。
 */
import * as React from 'react';
import type { McpServerInfo, ProviderSummary } from '@mozi/protocol';
import type { PolicyMode, PolicyRule } from '@mozi/shared';

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
}

const SANDBOX_LABELS: Record<number, string> = {
  0: 'L0 直执行',
  1: 'L1 进程组超时强杀',
  2: 'L2 平台隔离（Seatbelt / Landlock）',
  3: 'L3 Docker 隔离',
};

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="rounded-lg border border-neutral-700 p-3">
      <h2 className="mb-2 text-sm font-medium text-neutral-200">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const [jsonView, setJsonView] = React.useState(false);
  const [rulesJson, setRulesJson] = React.useState(JSON.stringify(props.policyRules, null, 2));
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const [keyDraft, setKeyDraft] = React.useState<Record<string, string>>({});

  return (
    <div className="mx-auto max-w-3xl space-y-3 overflow-auto p-4 text-sm">
      <Section title="模型 / Provider">
        <ul className="space-y-2">
          {props.providers.map((p) => (
            <li key={p.id} className="rounded border border-neutral-800 p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono">{p.id}</span>
                <span className="text-neutral-500">{p.model}</span>
                <span className={`ml-auto text-xs ${p.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {p.hasApiKey ? `已配置 ${p.maskedKey ?? ''}` : '未配置密钥'}
                </span>
              </div>
              <div className="mt-1 flex gap-2">
                <input
                  type="password"
                  className="flex-1 rounded bg-neutral-800 px-2 py-1 text-xs"
                  placeholder="API Key（经 OS 加密存储）"
                  value={keyDraft[p.id] ?? ''}
                  onChange={(e) => setKeyDraft({ ...keyDraft, [p.id]: e.target.value })}
                />
                <button
                  className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
                  onClick={() => {
                    props.onSetProviderKey(p.id, keyDraft[p.id] ?? '');
                    setKeyDraft({ ...keyDraft, [p.id]: '' });
                  }}
                >
                  保存
                </button>
                <button
                  className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
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
              {testResult[p.id] ? <div className="mt-1 text-xs text-neutral-400">{testResult[p.id]}</div> : null}
            </li>
          ))}
          {props.providers.length === 0 ? (
            <li className="text-xs text-neutral-600">（尚未添加 provider）</li>
          ) : null}
        </ul>
      </Section>

      <Section title="策略规则">
        <div className="mb-2 flex items-center gap-2">
          <select
            className="rounded bg-neutral-800 px-2 py-1 text-xs"
            value={props.policyMode}
            onChange={(e) => props.onSetPolicyMode(e.target.value as PolicyMode)}
          >
            <option value="readonly">readonly</option>
            <option value="auto">auto</option>
            <option value="full-auto">full-auto</option>
          </select>
          <button
            className="ml-auto rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
            onClick={() => setJsonView(!jsonView)}
          >
            {jsonView ? '表格视图' : 'JSON 视图'}
          </button>
        </div>
        {jsonView ? (
          <div>
            <textarea
              className="h-40 w-full rounded bg-neutral-800 p-2 font-mono text-xs"
              value={rulesJson}
              onChange={(e) => setRulesJson(e.target.value)}
            />
            <button
              className="mt-1 rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500"
              onClick={() => {
                try {
                  props.onSetPolicyRules(JSON.parse(rulesJson));
                } catch {
                  /* 非法 JSON：保持视图，用户继续编辑 */
                }
              }}
            >
              应用
            </button>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left">id</th>
                <th className="text-left">match</th>
                <th className="text-left">action</th>
              </tr>
            </thead>
            <tbody>
              {props.policyRules.map((r) => (
                <tr key={r.id} className="border-t border-neutral-800">
                  <td className="font-mono">{r.id}</td>
                  <td className="font-mono text-neutral-400">{JSON.stringify(r.match)}</td>
                  <td
                    className={
                      r.action === 'allow'
                        ? 'text-emerald-400'
                        : r.action === 'deny'
                          ? 'text-red-400'
                          : 'text-amber-400'
                    }
                  >
                    {r.action}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="MCP Server 管理">
        <ul className="space-y-1 text-xs">
          {props.mcpServers.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded border border-neutral-800 p-2">
              <span className="font-mono">{m.id}</span>
              <span className="text-neutral-500">{m.transport}</span>
              <span
                className={
                  m.status === 'connected'
                    ? 'text-emerald-400'
                    : m.status === 'offline'
                      ? 'text-red-400'
                      : 'text-amber-400'
                }
              >
                {m.status}
              </span>
              <span className="text-neutral-500">{m.toolCount} tools</span>
              <span className="ml-auto text-neutral-500">sampling: {m.sampling}</span>
            </li>
          ))}
          {props.mcpServers.length === 0 ? <li className="text-neutral-600">（未配置 MCP server）</li> : null}
        </ul>
      </Section>

      <Section title="沙箱级别">
        <select
          className="rounded bg-neutral-800 px-2 py-1 text-xs"
          value={props.sandboxLevel}
          onChange={(e) => props.onSetSandboxLevel(Number(e.target.value) as 0 | 1 | 2 | 3)}
        >
          {[0, 1, 2, 3].map((l) => (
            <option key={l} value={l}>
              {SANDBOX_LABELS[l]}
            </option>
          ))}
        </select>
      </Section>

      <Section title="成本上限">
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            每会话 $
            <input
              type="number"
              className="w-20 rounded bg-neutral-800 px-2 py-1"
              value={props.costLimits.perSessionUsd ?? ''}
              onChange={(e) =>
                props.onSetCostLimits({
                  ...props.costLimits,
                  perSessionUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label className="flex items-center gap-1">
            每日 $
            <input
              type="number"
              className="w-20 rounded bg-neutral-800 px-2 py-1"
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
      </Section>
    </div>
  );
}
