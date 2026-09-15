/**
 * 本地技能扫描器（+ 菜单「技能」分组 / SkillPanel 数据源）。
 *
 * 技能目录约定（与 Claude Code 风格对齐）：
 *   - 全局：~/.mozi/skills/<skill-name>/SKILL.md
 *   - 项目：<workspace>/.mozi/skills/<skill-name>/SKILL.md
 *
 * SKILL.md 头部 YAML frontmatter 提供元信息：
 *   ---
 *   name: 代码审阅
 *   description: 自动审阅代码变更
 *   icon: 🔍
 *   version: 1.0.0
 *   ---
 * 正文即技能指令（发送时引导引擎 read_file 读取）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillSummary } from '@mozi/protocol';

/** 内置技能（与 packages/desktop 内置能力对齐；随版本演进）。 */
export const BUILTIN_SKILLS: SkillSummary[] = [
  {
    id: 'code-review',
    name: '代码审阅',
    description: '自动审阅代码变更，识别风险、风格问题、安全漏洞',
    category: 'builtin',
    triggers: ['review', '审阅'],
    icon: '🔍',
    version: '1.0.0',
  },
  {
    id: 'git-flow',
    name: 'Git 工作流',
    description: '管理 Git 分支、提交、合并请求',
    category: 'builtin',
    triggers: ['git', 'commit'],
    icon: '🌿',
    version: '1.0.0',
  },
  {
    id: 'test-gen',
    name: '测试生成',
    description: '根据源码自动生成单元测试',
    category: 'builtin',
    triggers: ['test', '测试'],
    icon: '🧪',
    version: '1.0.0',
  },
  {
    id: 'refactor',
    name: '重构助手',
    description: '识别代码异味，建议并执行重构方案',
    category: 'builtin',
    triggers: ['refactor', '重构'],
    icon: '🔧',
    version: '1.0.0',
  },
  {
    id: 'debug-trace',
    name: '调试追踪',
    description: '分析错误堆栈，定位根因',
    category: 'builtin',
    triggers: ['debug', 'bug'],
    icon: '🐛',
    version: '1.0.0',
  },
  {
    id: 'doc-gen',
    name: '文档生成',
    description: '从代码注释提取文档，生成 API 参考',
    category: 'builtin',
    triggers: ['doc', '文档'],
    icon: '📄',
    version: '1.0.0',
  },
];

/** 解析 SKILL.md 的 YAML frontmatter（宽松子集：name/description/icon/version 字符串值）。 */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m || m[1] === undefined) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1] ?? '';
    let value = kv[2]?.trim() ?? '';
    // 去掉成对引号。
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 扫描一个技能根目录下的全部技能；目录不存在返回空。 */
export function scanSkillDir(root: string, category: 'custom' | 'project'): SkillSummary[] {
  const skills: SkillSummary[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const skillFile = path.join(root, d.name, 'SKILL.md');
    let text = '';
    try {
      text = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue; // 无 SKILL.md：不是合法技能目录
    }
    const fm = parseFrontmatter(text);
    skills.push({
      id: `${category}:${d.name}`,
      name: fm.name || d.name,
      description: fm.description || text.slice(0, 80).replace(/\s+/g, ' ').trim() || '（无描述）',
      category,
      source: skillFile,
      icon: fm.icon || '🧩',
      ...(fm.version ? { version: fm.version } : {}),
    });
  }
  return skills;
}

/** 汇总技能：内置 + 全局（~/.mozi/skills）+ 项目（<workspace>/.mozi/skills）。 */
export function listSkills(workspaceRoot?: string): SkillSummary[] {
  const globalDir = path.join(os.homedir(), '.mozi', 'skills');
  const all = [...BUILTIN_SKILLS, ...scanSkillDir(globalDir, 'custom')];
  if (workspaceRoot) {
    all.push(...scanSkillDir(path.join(workspaceRoot, '.mozi', 'skills'), 'project'));
  }
  // 同名去重：项目技能优先于全局，全局优先于内置。
  const byName = new Map<string, SkillSummary>();
  for (const s of all) {
    const key = s.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || skillRank(s) > skillRank(prev)) byName.set(key, s);
  }
  return [...byName.values()];
}

function skillRank(s: SkillSummary): number {
  return s.category === 'project' ? 3 : s.category === 'custom' ? 2 : 1;
}
