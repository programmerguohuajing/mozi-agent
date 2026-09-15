import path from 'node:path';
import type { ToolResult } from '@mozi/shared';
import { applyPatch } from './patch-applier.js';
import { parsePatch } from './patch-parser.js';
import { saveSnapshot } from './snapshots.js';
/**
 * edit_file 工具 —— 基于 PatchEngine 的结构化编辑（M3 §3.5）。
 */
import type { AgentTool, ToolContext } from './types.js';

const TOOL_NAME = 'edit_file';
const TOOL_VERSION = '1.0.0';

export const editFileTool: AgentTool = {
  name: TOOL_NAME,
  version: TOOL_VERSION,
  description: [
    'edit_file: 用结构化 patch 修改已有文件。',
    '规则：',
    '1) 修改前必须已 read_file 了解当前内容；禁止盲改。',
    '2) context 行选 2-3 行稳定锚点（函数签名、明显注释）；不要用空行做锚点。',
    '3) 新增多行代码放 Update 里；新建文件用 Add；删除整个文件用 Delete。',
    '4) 若改动行数超过文件 40%，改用 write_file 整体重写。',
    '5) patch 中所有路径相对工作区根。',
    '6) 失败会返回精确错误，请修正后重试，不要重复提交相同 patch。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Structured patch following the *** Begin Patch syntax.',
      },
    },
    required: ['patch'],
  },
  riskLevel: 'exec',

  async execute(input: { patch: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const patch = parsePatch(input.patch);
      const result = applyPatch(patch, ctx.workspace);

      // 持久化 /undo 快照（含 add 文件的 ABSENT 标记），目录按会话隔离
      const snapshotDir = path.join(ctx.workspace.root, '.mozi', 'snapshots', ctx.sessionId);
      const entries: Record<string, string | null> = Object.fromEntries(result.snapshots);
      for (const f of patch.files) {
        if (f.op === 'add' && !(f.path in entries)) entries[f.path] = null;
      }
      try {
        saveSnapshot(snapshotDir, entries);
      } catch {
        /* 快照落盘失败不阻塞编辑主流程 */
      }

      // 构建结果文本（每个文件一行摘要）
      const parts: string[] = [];
      for (const file of patch.files) {
        if (file.op === 'delete') {
          parts.push(`Deleted: ${file.path}`);
        } else if (file.op === 'add') {
          const after = result.after[file.path] ?? '';
          parts.push(`Added: ${file.path} (${after.split('\n').length} lines)`);
        } else {
          const before = result.before[file.path] ?? '';
          const after = result.after[file.path] ?? '';
          const delta = after.split('\n').length - before.split('\n').length;
          parts.push(`Updated: ${file.path} (${delta >= 0 ? '+' : ''}${delta} lines)`);
        }
      }

      // display: 取第一个 update 文件生成 diff 展示（单文件语义）
      let display: ToolResult['display'];
      const updateFile = patch.files.find((f) => f.op === 'update');
      if (updateFile) {
        const before = result.before[updateFile.path] ?? '';
        const after = result.after[updateFile.path] ?? '';
        display = {
          kind: 'diff',
          file: updateFile.path,
          before,
          after,
          hunks: updateFile.hunks?.length ?? 0,
        };
      }

      return {
        callId: '',
        content: parts.join('\n'),
        isError: false,
        display,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code;
      return {
        callId: '',
        content: `edit_file failed: ${msg}`,
        isError: true,
        meta: { errorKind: code ?? 'ERR_TOOL_INTERNAL' },
      };
    }
  },
};
