/**
 * grep：递归正则内容搜索（轻量自实现，返回 文件:行号:内容）（M3 §3.3.5）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '@mozi/shared';
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';
import type { Workspace } from './workspace.js';

interface GrepInput {
  pattern: string;
  cwd?: string;
  include?: string[];
  exclude?: string[];
  maxMatches?: number;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.mozi', '.turbo', 'coverage']);

export const grepTool: AgentTool<GrepInput> = {
  name: 'grep',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Search file contents by regular expression.',
    'Returns matching lines as "relative/path:line:content".',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      cwd: { type: 'string', description: 'Base directory (relative), default root.' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to include.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to exclude.',
      },
      maxMatches: { type: 'number', description: 'Max matches, default 50.' },
    },
    required: ['pattern'],
  },
  async execute(input: GrepInput, ctx: ToolContext) {
    const ws: Workspace = ctx.workspace;
    const base = input.cwd ? ws.resolve(input.cwd) : ws.root;
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, 'g');
    } catch {
      return fail(`invalid regex: ${input.pattern}`, 'ERR_TOOL_VALIDATION');
    }
    const max = input.maxMatches ?? 50;
    const include = input.include?.map(globToRegExp);
    const exclude = input.exclude?.map(globToRegExp);
    const out: string[] = [];

    const walk = (dir: string): void => {
      if (out.length >= max) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(ws.root, abs).split(path.sep).join('/');
        if (e.isDirectory()) {
          walk(abs);
        } else {
          if (exclude?.some((r) => r.test(rel))) continue;
          if (include?.length && !include.some((r) => r.test(rel))) continue;
          let text: string;
          try {
            const b = fs.readFileSync(abs);
            if (b.subarray(0, 8192).includes(0)) continue;
            text = b.toString('utf8');
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (out.length >= max) break;
            re.lastIndex = 0;
            const line = lines[i] ?? '';
            if (re.test(line)) out.push(`${rel}:${i + 1}:${line}`);
          }
        }
        if (out.length >= max) break;
      }
    };
    walk(base);

    const truncated = out.length >= max;
    const more = truncated ? '\n... [truncated, refine pattern]' : '';
    return ok(`<grep "${input.pattern}" matched ${out.length} lines>${more}\n${out.join('\n')}`);
  },
};
