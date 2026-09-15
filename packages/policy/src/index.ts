/**
 * 审批策略引擎（M6 §6.1）。三档模式 + 内置安全规则 + 确定性强评估。
 */
import type {
  ApprovalReason,
  PolicyConfig,
  PolicyDecision,
  PolicyMode,
  PolicyRule,
  RiskLevel,
  ToolCall,
} from '@mozi/shared';
import { matchGlob } from '@mozi/shared';
import { analyzeCommand, riskToApproval } from './risk-analyzer.js';

export * from './risk-analyzer.js';

/** 内置安全默认规则（全部为 deny/ask，优先级低于用户自定义 rules）。 */
export const BUILTIN_RULES: PolicyRule[] = [
  { id: 'R_rm_rf', match: { tool: 'shell', commandPattern: 'rm\\s+-(rf|fr)' }, action: 'deny' },
  {
    id: 'R_git_push_f',
    match: { tool: 'shell', commandPattern: 'git\\s+push\\s+.*--force' },
    action: 'ask',
  },
  {
    id: 'R_curl_pipe_sh',
    match: { tool: 'shell', commandPattern: '(curl|wget).+\\|\\s*(ba)?sh' },
    action: 'deny',
  },
  {
    id: 'R_net',
    match: { tool: 'shell', commandPattern: '(curl|wget|nc|ssh|git\\s+clone)' },
    action: 'ask',
  },
  {
    id: 'R_secrets',
    match: { tool: 'write_file', pathGlob: '{.env*,**/secrets/**,**/*.pem,**/*.key}' },
    action: 'ask',
  },
  {
    id: 'R_erase',
    match: { tool: 'write_file', pathGlob: '{**/*.lock,**/node_modules/**}' },
    action: 'ask',
  },
];

const DEFAULT_TABLE: Record<PolicyMode, Record<RiskLevel, 'allow' | 'ask' | 'deny'>> = {
  readonly: { read: 'allow', write: 'deny', exec: 'deny', meta: 'allow' },
  auto: { read: 'allow', write: 'allow', exec: 'ask', meta: 'allow' },
  'full-auto': { read: 'allow', write: 'allow', exec: 'allow', meta: 'allow' },
};

export interface EvaluateOptions {
  /** 无人值守（定时任务 headless）时，ask 一律降级为 deny（M13 不变式 I1）。 */
  unattended?: boolean;
}

function ruleMatches(rule: PolicyRule, call: ToolCall): boolean {
  const m = rule.match;
  if (m.tool) {
    const tools = Array.isArray(m.tool) ? m.tool : [m.tool];
    if (!tools.includes(call.name)) return false;
  }
  if (m.commandPattern) {
    if (call.name !== 'shell') return false;
    const cmd = (call.arguments as { command?: unknown } | undefined)?.command;
    if (typeof cmd !== 'string') return false;
    if (!new RegExp(m.commandPattern).test(cmd)) return false;
  }
  if (m.pathGlob) {
    const p = (call.arguments as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string') return false;
    if (!matchGlob(m.pathGlob, p)) return false;
  }
  return true;
}

function describe(rule: PolicyRule, call: ToolCall): string {
  const parts: string[] = [];
  if (typeof rule.match.commandPattern === 'string')
    parts.push(`command matches /${rule.match.commandPattern}/`);
  if (typeof rule.match.pathGlob === 'string') parts.push(`path matches ${rule.match.pathGlob}`);
  if (typeof rule.match.tool === 'string' || Array.isArray(rule.match.tool))
    parts.push(`tool=${call.name}`);
  return parts.join(', ');
}

export class PolicyEngine {
  constructor(private readonly builtin: PolicyRule[] = BUILTIN_RULES) {}

  evaluate(call: ToolCall, config: PolicyConfig, opts: EvaluateOptions = {}): PolicyDecision {
    const rules = [...config.rules, ...this.builtin];
    for (const rule of rules) {
      if (!ruleMatches(rule, call)) continue;
      if (rule.action === 'deny') return { type: 'deny', ruleId: rule.id };
      if (rule.action === 'ask') {
        const reason: ApprovalReason = {
          kind: 'policy',
          ruleId: rule.id,
          detail: `matched rule ${rule.id} (${describe(rule, call)})`,
        };
        if (opts.unattended) {
          return { type: 'deny', ruleId: rule.id };
        }
        return { type: 'ask', reason, ruleId: rule.id };
      }
      return { type: 'allow', ruleId: rule.id };
    }

    // shell 且无规则命中 → 命令风险分析（M6 §6.2）：结构化拆解 + 综合评级
    if (call.name === 'shell') {
      const command = (call.arguments as { command?: unknown } | undefined)?.command ?? '';
      if (typeof command === 'string' && command.trim()) {
        const { segments, overall } = analyzeCommand(command);
        const verdict = riskToApproval(overall);
        if (verdict === 'deny') {
          return { type: 'deny', ruleId: 'X_risk_high' };
        }
        if (verdict === 'ask') {
          if (opts.unattended) return { type: 'deny', ruleId: 'X_risk_ask_unattended' };
          const reason: ApprovalReason = { kind: 'risk', segments };
          return { type: 'ask', reason, ruleId: `X_risk_${overall}` };
        }
        // safe 白名单 → 放行
        return { type: 'allow', ruleId: 'X_risk_safe' };
      }
    }

    const fallback = DEFAULT_TABLE[config.mode][call.riskLevel];
    if (fallback === 'deny') return { type: 'deny', ruleId: `mode:${config.mode}` };
    if (fallback === 'ask') {
      if (opts.unattended) return { type: 'deny', ruleId: `mode:${config.mode}` };
      const reason: ApprovalReason = {
        kind: 'manual',
        note: `mode '${config.mode}' requires approval for ${call.riskLevel} tool '${call.name}'`,
      };
      return { type: 'ask', reason, ruleId: `mode:${config.mode}` };
    }
    return { type: 'allow', ruleId: `mode:${config.mode}` };
  }
}
