/**
 * PromptAssembler（M15 §15.3）：五层提示词架构的 L0-L3 组装。
 *
 *   L0 基座层  identity.md           静态，永不裁剪
 *   L1 环境层  每 turn 动态           工作区/平台/git/日期/模型名
 *   L2 能力层  按 enabledTools 裁剪   每工具/能力一段准则
 *   L3 策略层  按 policy.mode 注入    只读/自动/全自动 三档文案
 *   L4 任务层  ContextManager 注入    AGENTS.md / 记忆 / 人格（不在此拼装）
 *
 * 层间独立性：L4 不可覆盖 L0 安全准则——物理上 L0 恒在最前，L4 由 ContextManager
 * 在 L0-L3 之后追加并带来源标注。
 *
 * 变更可见性：组装结果 hash 记入 session.started 事件与 meta.json（promptHash）。
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import { CAPABILITY_FILES, PromptAssets } from './assets.js';

/** 默认总预算（token），§15.3。 */
export const PROMPT_BUDGET_TOKENS = 6_000;

/** L1 环境的输入（由调用方从 Session 提取，避免本模块依赖 session-store）。 */
export interface PromptEnvironment {
  workspace: string;
  /** 会话 id（诊断用，不注入正文）。 */
  sessionId?: string;
  /** 子智能体模板类型（如 explore/general）。 */
  agentType?: string;
  /** 嵌套深度。 */
  depth?: number;
  /** 执行模型名。 */
  model?: string;
  /** git 分支（可选）。 */
  gitBranch?: string;
  /** 当前日期 yyyy-mm-dd（可选，便于快照测试注入固定值）。 */
  today?: string;
}

export interface PromptBuildInput {
  /** 工具白名单（'*' 或显式列表）。 */
  enabledTools?: string[];
  /** 审批模式：readonly | auto | full-auto。 */
  policyMode?: string;
  environment: PromptEnvironment;
  /** 模型输入上限极小时（<4k）降级为精简版 identity（§15.6）。 */
  lite?: boolean;
}

export interface PromptBuildResult {
  /** 组装后的 L0-L3 文本（L4 由 ContextManager 追加）。 */
  text: string;
  /** 组装结果 hash（前 12 位），记入 session.started / meta.json。 */
  promptHash: string;
  /** prompt 目录版本（内容 hash 前 8 位，§15.5）。 */
  promptVersion: string;
  /** 各层是否因预算被裁剪（诊断用）。 */
  trimmed: { capabilities: boolean; environment: boolean };
  /** 估算 token 数。 */
  estimatedTokens: number;
}

/** 粗略 token 估算：CJK 约 1 token/字，ASCII 约 1 token/4 字符。 */
export function estimatePromptTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export class PromptAssembler {
  private readonly assets: PromptAssets;
  /** 静态段缓存（按内容 hash 键），避免每 turn 重复读盘。 */
  private readonly staticCache = new Map<string, string>();

  constructor(opts?: { promptsDir?: string; assets?: PromptAssets }) {
    this.assets = opts?.assets ?? new PromptAssets(opts?.promptsDir);
  }

  /** 含 prompts 目录版本的映射，供 engine 写入 meta。 */
  version(): string {
    return this.assets.version();
  }

  build(input: PromptBuildInput): PromptBuildResult {
    const parts: string[] = [];

    // ---- L0 基座层（静态，永不裁剪）----
    const identityKey = input.lite ? 'identity-lite' : 'identity';
    let identity = this.staticCache.get(identityKey);
    if (identity === undefined) {
      identity = (input.lite ? this.assets.identityLite() : this.assets.identity()).trim();
      this.staticCache.set(identityKey, identity);
    }
    parts.push(identity);

    // ---- L1 环境层（每 turn 动态）----
    const env = this.environment(input.environment);
    parts.push(env.full);

    // ---- L2 能力层（按 enabledTools 裁剪，静态段缓存）----
    const capKey = `caps:${[...expandCapabilities(input.enabledTools ?? ['*'])].sort().join(',')}`;
    let caps = this.staticCache.get(capKey);
    if (caps === undefined) {
      caps = this.capabilities(input.enabledTools ?? ['*']);
      this.staticCache.set(capKey, caps);
    }
    if (caps) parts.push(caps);

    // ---- L3 策略层（按 mode 分支文案）----
    const notes = this.assets.policy(input.policyMode ?? 'auto');
    if (notes) parts.push(notes);

    // ---- 组装 + 预算裁剪 ----
    let text = parts.filter((p) => p && p.trim().length > 0).join('\n\n');
    let capTrimmed = false;
    let envTrimmed = false;

    if (estimatePromptTokens(text) > PROMPT_BUDGET_TOKENS) {
      // 裁剪序 1：L2 未使用工具的准则段压缩（整段丢弃，仅保留核心工具段）。
      const coreCaps = this.capabilities(input.enabledTools ?? ['*'], { coreOnly: true });
      const rebuilt = [
        identity,
        env.full,
        coreCaps,
        notes ?? '',
      ].filter((p) => p && p.trim().length > 0);
      // L0 与 L3 必须保留；L2 降级为核心段。
      const candidate = rebuilt.join('\n\n');
      if (estimatePromptTokens(candidate) < estimatePromptTokens(text)) {
        text = candidate;
        capTrimmed = true;
      }
      // 裁剪序 2：L1 环境细节压缩（保留 cwd 与 git）。
      if (estimatePromptTokens(text) > PROMPT_BUDGET_TOKENS) {
        const rebuilt2 = [identity, env.minimal, coreCaps, notes ?? ''].filter(
          (p) => p && p.trim().length > 0,
        );
        const candidate2 = rebuilt2.join('\n\n');
        if (estimatePromptTokens(candidate2) < estimatePromptTokens(text)) {
          text = candidate2;
          envTrimmed = true;
        }
      }
      // 裁剪序 3：极端情况仍超预算——L0 永不裁剪，如实返回（由 provider 层兜底）。
    }

    return {
      text,
      promptHash: createHash('sha256').update(text).digest('hex').slice(0, 12),
      promptVersion: this.assets.version(),
      trimmed: { capabilities: capTrimmed, environment: envTrimmed },
      estimatedTokens: estimatePromptTokens(text),
    };
  }

  /** L1 环境层：full（默认）与 minimal（超预算时保留 cwd 与 git）。 */
  private environment(e: PromptEnvironment): { full: string; minimal: string } {
    const today = e.today ?? new Date().toISOString().slice(0, 10);
    const minimal = [
      '# 环境',
      `- 工作区: ${e.workspace}`,
      e.gitBranch ? `- git 分支: ${e.gitBranch}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const lines = [
      '# 环境',
      `- 工作区: ${e.workspace}`,
      `- 平台: ${process.platform} (${os.release()})`,
      e.gitBranch ? `- git 分支: ${e.gitBranch}` : '- git 分支: (非 git 仓库或未知)',
      `- 日期: ${today}`,
      `- 执行模型: ${e.model ?? 'unknown'}`,
    ];
    if (typeof e.depth === 'number' && e.depth > 0) {
      lines.push(`- 你是子智能体（${e.agentType ?? 'general'}，深度 ${e.depth}）：只完成被委派的子任务，不要扩大范围。`);
    }
    return { full: lines.join('\n'), minimal };
  }

  /** L2 能力层：按 enabledTools 展开为去重的能力段。 */
  private capabilities(enabledTools: string[], opts?: { coreOnly?: boolean }): string {
    const files = expandCapabilities(enabledTools, opts);
    const sections: string[] = [];
    for (const f of files) {
      const text = this.assets.capability(f);
      if (text) sections.push(text);
    }
    if (!sections.length) return '';
    return ['# 工具使用准则', ...sections].join('\n\n');
  }
}

/** 核心能力（超预算时保留）：读写与 shell——任务完成的必需面。 */
const CORE_CAPABILITIES = new Set(['read', 'write', 'shell']);

/**
 * 把 enabledTools 展开为能力文件名集合。
 * '*' 表示全部已知能力；'coreOnly' 时仅保留 CORE_CAPABILITIES。
 */
export function expandCapabilities(
  enabledTools: string[],
  opts?: { coreOnly?: boolean },
): Set<string> {
  const all = enabledTools.includes('*');
  const out = new Set<string>();
  for (const [tool, file] of Object.entries(CAPABILITY_FILES)) {
    const enabled = all || enabledTools.includes(tool);
    if (!enabled) continue;
    if (opts?.coreOnly && !CORE_CAPABILITIES.has(file)) continue;
    out.add(file);
  }
  return out;
}
