/**
 * 策略引擎类型（M6 §6.1）。
 * 不含实现，仅契约；实现见 @mozi/policy。
 */

export type PolicyMode = 'readonly' | 'auto' | 'full-auto';

export interface PolicyRule {
  id: string;
  match: {
    tool?: string | string[];
    commandPattern?: string; // shell 专用：JS RegExp 源码
    pathGlob?: string; // 文件类工具专用
  };
  action: 'allow' | 'ask' | 'deny';
}

export interface PolicyConfig {
  mode: PolicyMode;
  rules: PolicyRule[];
}

export type ApprovalReason =
  | { kind: 'policy'; ruleId: string; detail: string }
  | { kind: 'risk'; segments: import('./events.js').CommandSegment[] }
  | { kind: 'manual'; note: string };

export type PolicyDecision =
  | { type: 'allow'; ruleId?: string }
  | { type: 'ask'; reason: ApprovalReason; ruleId: string }
  | { type: 'deny'; ruleId: string };
