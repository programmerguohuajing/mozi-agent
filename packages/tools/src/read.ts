/**
 * read_file：读取文件（行区间 / 行号前缀）+ 目录列出 + 二进制探测（M3 §3.3.1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok } from './types.js';
import type { Workspace } from './workspace.js';

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export const readFileTool: AgentTool<ReadInput> = {
  name: 'read_file',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Read a file from the workspace and return it with 1-based line numbers.',
    'Supports "offset" (start line, 1-based) and "limit" (max lines, default 500, max 2000).',
    'If "path" is a directory, lists its entries instead.',
    'Binary files are detected and reported without dumping bytes.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory path, relative to workspace root.' },
      offset: { type: 'number', description: 'Start line (1-based), default 1.' },
      limit: { type: 'number', description: 'Max lines to return, default 500.' },
    },
    required: ['path'],
  },
  async execute(input: ReadInput, ctx: ToolContext) {
    const ws: Workspace = ctx.workspace;
    const full = ws.resolve(input.path);
    if (!fs.existsSync(full)) {
      return fail(`file not found: ${input.path}`, ErrorCodes.ERR_FILE_NOT_FOUND);
    }
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(full)
        .sort()
        .map((e) => (fs.statSync(path.join(full, e)).isDirectory() ? `${e}/` : e));
      return ok(`<dir:${input.path}>\n${entries.join('\n')}`);
    }
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8192).includes(0)) {
      return ok(
        `binary file: ${input.path} (${stat.size} bytes). Use shell tools (xxd/file) to inspect.`,
      );
    }
    const lines = buf.toString('utf8').split('\n');
    const total = lines.length;
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.min(input.limit ?? 500, 2000);
    const end = Math.min(offset + limit - 1, total);
    const slice = lines.slice(offset - 1, end);
    const numbered = slice.map((line, idx) => `${offset + idx}  | ${line}`).join('\n');
    const omitted =
      end < total ? `\n<... lines ${end + 1}-${total} omitted; use offset=${end + 1} ...>` : '';
    const rel = path.relative(ws.root, full) || input.path;
    return ok(`<file:${rel} (${offset}-${end}/${total})>\n${numbered}${omitted}`);
  },
};
