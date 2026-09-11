/**
 * glob：按模式查找文件路径（轻量自实现，支持 ** / * / ?）（M3 §3.3.4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '@mozi/shared';
import type { AgentTool, ToolContext } from './types.js';
import { ok } from './types.js';
import type { Workspace } from './workspace.js';

interface GlobInput {
  pattern: string;
  cwd?: string;
  limit?: number;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.mozi', '.turbo', 'coverage']);

export const globTool: AgentTool<GlobInput> = {
  name: 'glob',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Find files by glob pattern. Supports "**" (any nesting), "*" (single segment), "?".',
    'Returns matching paths relative to the workspace root.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "packages/**/*.ts".' },
      cwd: { type: 'string', description: 'Base directory (relative to workspace), default root.' },
      limit: { type: 'number', description: 'Max results, default 200.' },
    },
    required: ['pattern'],
  },
  async execute(input: GlobInput, ctx: ToolContext) {
    const ws: Workspace = ctx.workspace;
    const base = input.cwd ? ws.resolve(input.cwd) : ws.root;
    const limit = input.limit ?? 200;
    const re = globToRegExp(input.pattern);
    const matches: string[] = [];

    const walk = (dir: string): void => {
      if (matches.length >= limit) return;
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
          if (re.test(rel)) matches.push(rel);
          walk(abs);
        } else if (re.test(rel)) {
          matches.push(rel);
        }
        if (matches.length >= limit) break;
      }
    };
    walk(base);

    const capped = matches.slice(0, limit);
    const more = matches.length > limit ? `\n... [truncated, ${matches.length - limit} more]` : '';
    return ok(
      `<glob "${input.pattern}" matched ${capped.length} files>${more}\n${capped.join('\n')}`,
    );
  },
};
