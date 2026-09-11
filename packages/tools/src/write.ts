/**
 * write_file：新建 / 整体覆写文件（幂等建父目录）（M3 §3.3.2）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentTool, ToolContext } from './types.js';
import { ok } from './types.js';
import type { Workspace } from './workspace.js';

interface WriteInput {
  path: string;
  content: string;
}

export const writeFileTool: AgentTool<WriteInput> = {
  name: 'write_file',
  version: '1.0.0',
  riskLevel: 'write',
  description: [
    'Write or overwrite a file in the workspace. Creates parent directories as needed.',
    'Use for new files or full rewrites of small files.',
    'For editing existing files, prefer edit_file when available.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path, relative to workspace root.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
  async execute(input: WriteInput, ctx: ToolContext) {
    const ws: Workspace = ctx.workspace;
    const full = ws.resolve(input.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, input.content ?? '');
    const bytes = Buffer.byteLength(input.content ?? '');
    return ok(`wrote ${bytes} bytes to ${input.path}`);
  },
};
