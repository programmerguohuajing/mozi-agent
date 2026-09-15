/**
 * 子智能体模板（M12 §12.3）。
 * 内置 explore / general / reviewer，并支持从 .mozi/agents/*.md 与 .claude/agents/*.md 加载自定义模板。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PolicyMode } from '@mozi/shared';

export interface AgentTemplate {
  type: string;
  description: string;
  systemPrompt: string;
  policy: PolicyMode;
  allowedTools: string[] | '*';
  allowSubAgents: boolean;
  maxSteps: number;
  contextBudgetTokens: number;
  timeoutMs: number;
}

/** readonly 角色常用的只读工具集。 */
const READONLY_TOOLS = ['read_file', 'glob', 'grep', 'list_dir'];

export const BUILTIN_TEMPLATES: AgentTemplate[] = [
  {
    type: 'explore',
    description:
      'Read-only code explorer: use for broad search/reading where you only need the conclusion. ' +
      'Returns a structured summary with file:line references. Cannot modify files.',
    policy: 'readonly',
    allowedTools: READONLY_TOOLS,
    allowSubAgents: false,
    maxSteps: 30,
    contextBudgetTokens: 32_000,
    timeoutMs: 300_000,
    systemPrompt: [
      'You are an explore sub-agent (read-only). Your job is to investigate the codebase and report back.',
      'Rules:',
      '- Never modify files. You have only read_file / glob / grep / list_dir.',
      '- Be efficient: prefer targeted grep/glob over reading whole trees.',
      '- Your final message is the ONLY thing the parent agent will see. It MUST be a structured summary:',
      '  ## 结论 (conclusion)',
      '  ## 相关文件 (relevant files, as file:line with a one-line note each)',
      '  ## 建议 (recommended next steps)',
      '- Always cite concrete file:line references. Do not pad with raw file contents.',
    ].join('\n'),
  },
  {
    type: 'general',
    description:
      'General-purpose sub-agent for delegated work that may modify files. ' +
      'Inherits the parent policy (tightened, never loosened).',
    policy: 'auto',
    allowedTools: '*',
    allowSubAgents: true,
    maxSteps: 50,
    contextBudgetTokens: 64_000,
    timeoutMs: 600_000,
    systemPrompt: [
      'You are a general sub-agent. Complete the delegated subtask end-to-end.',
      'Your permissions are no broader than the parent session. If a tool is denied, adapt or report it.',
      'Your final message is the ONLY thing the parent agent will see, so it MUST be a structured summary:',
      '  ## 结论 (what you did / found)',
      '  ## 相关文件 (file:line)',
      '  ## 建议 (follow-ups or unblocking notes)',
    ].join('\n'),
  },
  {
    type: 'reviewer',
    description:
      'Read-only code reviewer: inspects specified code and returns a prioritised issue list ' +
      '(severity / file / line / suggestion).',
    policy: 'readonly',
    allowedTools: ['read_file', 'glob', 'grep'],
    allowSubAgents: false,
    maxSteps: 20,
    contextBudgetTokens: 32_000,
    timeoutMs: 300_000,
    systemPrompt: [
      'You are a code reviewer sub-agent (read-only). Review the code the parent points you at.',
      'Your final message is the ONLY thing the parent agent will see. Output a structured review:',
      '  ## 结论',
      '  ## 问题清单 (one per line: [severity] file:line — issue — suggestion; severity ∈ high/medium/low)',
      '  ## 建议',
      'Be specific and cite file:line. Do not restate the whole file.',
    ].join('\n'),
  },
];

export class TemplateRegistry {
  private readonly byType = new Map<string, AgentTemplate>();

  constructor(templates: AgentTemplate[] = BUILTIN_TEMPLATES) {
    for (const t of templates) this.byType.set(t.type, t);
  }

  register(t: AgentTemplate): void {
    this.byType.set(t.type, t);
  }

  resolve(type: string): AgentTemplate | undefined {
    return this.byType.get(type);
  }

  list(): AgentTemplate[] {
    return [...this.byType.values()];
  }
}

/** 解析简单 frontmatter（--- ... ---），不做 YAML 依赖。 */
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  return { fields, body: m[2] ?? '' };
}

function parseTools(raw: string | undefined): string[] | '*' {
  if (!raw) return '*';
  const v = raw.trim();
  if (v === '*' || v === '"*"' || v === "'*'") return '*';
  const inner = v.replace(/^\[/, '').replace(/\]$/, '');
  const items = inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return items.length ? items : '*';
}

function parseBudgetK(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw.replace(/k$/i, '').trim());
  if (!Number.isFinite(n)) return fallback;
  return /k$/i.test(raw.trim()) ? n * 1000 : n;
}

function toTemplate(name: string, fields: Record<string, string>, body: string): AgentTemplate {
  const policy = (fields.policy ?? 'auto').trim() as PolicyMode;
  const valid: PolicyMode[] = ['readonly', 'auto', 'full-auto'];
  return {
    type: fields.type?.trim() || name,
    description: fields.description?.trim() || `${name} sub-agent`,
    systemPrompt: body.trim() || `You are the ${name} sub-agent.`,
    policy: valid.includes(policy) ? policy : 'auto',
    allowedTools: parseTools(fields.tools),
    allowSubAgents: fields.allow_subagents === 'true',
    maxSteps: Number.parseInt(fields.steps ?? '30', 10) || 30,
    contextBudgetTokens: parseBudgetK(fields.budget, 32_000),
    timeoutMs: Number.parseInt(fields.timeoutMs ?? '300000', 10) || 300_000,
  };
}

/**
 * 从目录约定加载自定义模板（§12.3）：
 *   <workspace>/.mozi/agents/*.md → mozi 原生
 *   <workspace>/.claude/agents/*.md → 兼容读取
 *   ~/.mozi/agents/*.md → 用户全局
 * 后加载者覆盖同类型名（项目 > 全局）。
 */
export function loadAgentTemplates(workspaceRoot: string): AgentTemplate[] {
  const dirs = [
    path.join(os.homedir(), '.mozi', 'agents'),
    path.join(workspaceRoot, '.claude', 'agents'),
    path.join(workspaceRoot, '.mozi', 'agents'),
  ];
  const out: AgentTemplate[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const { fields, body } = parseFrontmatter(text);
        out.push(toTemplate(path.basename(f, '.md'), fields, body));
      } catch {
        /* 单个模板失败不影响其他 */
      }
    }
  }
  return out;
}

/** 构建模板注册表：内置 + 自定义（自定义可覆盖内置同名）。 */
export function createTemplateRegistry(workspaceRoot: string): TemplateRegistry {
  const reg = new TemplateRegistry();
  for (const t of loadAgentTemplates(workspaceRoot)) reg.register(t);
  return reg;
}
