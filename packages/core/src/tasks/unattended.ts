/**
 * 无人值守安全模型（M4.5 / M13 §13.5）：三档策略 → PolicyMode + 规则集合成；
 * 静态校验（I4 full→L3、allowlist 空名单拒绝）；默认无人值守 system prompt。
 *
 * 不变式（PolicyEngine.evaluate({ unattended: true }) 已在引擎层注入）：
 *  - I1 无人值守下不存在 'ask' 决策——ask 静态化为 deny
 *  - I2 deny 结果携带原因（ruleId），模型可自纠
 *  - I3 内置高危 deny（rm -rf / curl|sh 等）在所有模式下不可绕过（置于 allow 规则之前）
 *  - I4 full 模式强制 sandboxLevel >= 3；不满足 → 任务创建校验失败
 *  - I5 成本上限 maxCostUsd 触发 → 中止运行（引擎层）
 */
import { BUILTIN_RULES } from '@mozi/policy';
import type { PolicyMode, PolicyRule } from '@mozi/shared';
import type { TaskRunConfig, UnattendedPolicy } from './types.js';
import { DEFAULT_TASK_OPTIONS } from './types.js';

export interface UnattendedPolicyBuild {
  policyMode: PolicyMode;
  rules: PolicyRule[];
  /** 无人值守注入引擎时使用的 evaluate 选项 */
  evaluateOptions: { unattended: true };
}

export interface ValidationIssue {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 任务配置静态校验（mozi task add 时执行，不等到运行时才炸） */
export function validateTaskConfig(config: TaskRunConfig): ValidationIssue {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = config.policy;
  if (p.mode === 'full' && config.artifact === 'direct') {
    errors.push('full + artifact=direct：无人值守直改工作区且全放行不可接受（I4）');
  }
  if (p.mode === 'allowlist') {
    const cmds = p.allowlist?.commands ?? [];
    const paths = p.allowlist?.writePathGlobs ?? [];
    if (cmds.length === 0 && paths.length === 0) {
      errors.push('allowlist 未配置任何白名单（等价全 deny，必是配置错误）');
    }
  }
  if (p.mode === 'full' && (config.sandboxLevel ?? DEFAULT_TASK_OPTIONS.sandboxLevel) < 3) {
    errors.push('full 模式强制 sandboxLevel >= 3（容器沙箱），当前不满足（I4）');
  }
  if (p.mode === 'readonly' && (config.artifact === 'branch' || config.artifact === 'pr')) {
    warnings.push('readonly + artifact=branch/pr：只读任务通常不产生产物分支');
  }
  if (config.artifact === 'direct' && p.mode !== 'allowlist') {
    warnings.push('direct 产物策略建议搭配 allowlist 策略使用（严格限制写入）');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 合成无人值守策略 → PolicyMode + rules（13.5 模式语义表） */
export function buildUnattendedPolicy(policy: UnattendedPolicy): UnattendedPolicyBuild {
  switch (policy.mode) {
    case 'readonly':
      return { policyMode: 'readonly', rules: [], evaluateOptions: { unattended: true } };
    case 'full':
      return { policyMode: 'full-auto', rules: [], evaluateOptions: { unattended: true } };
    case 'allowlist': {
      // 规则顺序：内置高危 deny（I3 不可绕过）→ 白名单 allow → 兜底 deny（I2 带 ruleId）
      const denyOnly = BUILTIN_RULES.filter((r) => r.action === 'deny');
      const rules: PolicyRule[] = [...denyOnly];
      for (const cmd of policy.allowlist?.commands ?? []) {
        const c = cmd.trim();
        if (!c) continue;
        rules.push({
          id: `W_shell_${rules.length}`,
          match: { tool: 'shell', commandPattern: `^${escapeRegExp(c)}` },
          action: 'allow',
        });
      }
      for (const glob of policy.allowlist?.writePathGlobs ?? []) {
        rules.push({
          id: `W_write_${rules.length}`,
          match: { tool: ['write_file', 'edit_file'], pathGlob: glob },
          action: 'allow',
        });
      }
      rules.push(
        {
          id: 'X_allowlist_shell_deny',
          match: { tool: 'shell', commandPattern: '^.+$' },
          action: 'deny',
        },
        {
          id: 'X_allowlist_write_deny',
          match: { tool: ['write_file', 'edit_file'], pathGlob: '**' },
          action: 'deny',
        },
      );
      return { policyMode: 'auto', rules, evaluateOptions: { unattended: true } };
    }
  }
}

/** 有效运行参数（13.3 默认值收紧） */
export function effectiveRunConfig(config: TaskRunConfig) {
  return {
    model: config.model,
    maxSteps: config.maxSteps ?? DEFAULT_TASK_OPTIONS.maxSteps,
    maxCostUsd: config.maxCostUsd ?? DEFAULT_TASK_OPTIONS.maxCostUsd,
    timeoutMs: config.timeoutMs ?? DEFAULT_TASK_OPTIONS.timeoutMs,
    sandboxLevel: config.sandboxLevel ?? DEFAULT_TASK_OPTIONS.sandboxLevel,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}