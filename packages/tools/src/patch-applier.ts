/**
 * Patch applier —— 事务型应用器，带快照回滚（M3 §3.5.4）。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { Workspace } from './workspace.js';
import type { PatchFile } from './patch-parser.js';
import { PatchMatchError, matchFile, applyLocations } from './patch-matcher.js';

export interface ApplyResult {
  /** path -> 修改前内容（Add 文件为空串） */
  before: Record<string, string>;
  /** path -> 修改后内容（Delete 文件为空串） */
  after: Record<string, string>;
  /** 本次事务的快照（供 /undo 恢复） */
  snapshots: Map<string, string>;
}

export function applyPatch(
  patch: { files: PatchFile[] },
  workspace: Workspace,
  snapshotDir?: string,
): ApplyResult {
  const snapshots = new Map<string, string>(); // path -> before content
  const results = new Map<string, string>();   // path -> new content
  let applied = false;

  try {
    // Phase 1：全部匹配（只读，不写盘）。任一失败 → 整个 patch 拒绝。
    for (const file of patch.files) {
      if (file.op === 'update') {
        if (!file.hunks || file.hunks.length === 0) {
          throw new MoziError(
            ErrorCodes.ERR_PATCH_PARSE,
            `Update file '${file.path}' has no hunks`,
            true,
          );
        }
        const raw = workspace.readFile(file.path);
        if (raw == null) {
          throw new MoziError(
            ErrorCodes.ERR_FILE_NOT_FOUND,
            `Target file not found: ${file.path}`,
            true,
          );
        }
        if (!snapshots.has(file.path)) snapshots.set(file.path, raw);

        const matchResult = matchFile(file.path, raw, file.hunks);
        if ('error' in matchResult) throw new PatchMatchError(matchResult.error);

        const lines = raw.split('\n');
        const rebuilt = applyLocations(lines, file.hunks, matchResult.locations);
        results.set(file.path, rebuilt.join('\n'));
      } else if (file.op === 'add') {
        const raw = workspace.readFile(file.path);
        if (raw != null) {
          throw new MoziError(
            ErrorCodes.ERR_TOOL_VALIDATION,
            `Add File '${file.path}' already exists (use Update instead)`,
            true,
          );
        }
        results.set(file.path, (file.body ?? []).join('\n'));
      } else {
        // delete
        const raw = workspace.readFile(file.path);
        if (raw == null) {
          throw new MoziError(
            ErrorCodes.ERR_FILE_NOT_FOUND,
            `Delete target not found: ${file.path}`,
            true,
          );
        }
        snapshots.set(file.path, raw);
        results.set(file.path, '');
      }
    }

    // Phase 2：统一写入（事务）
    if (snapshotDir) {
      try {
        mkdirSync(snapshotDir, { recursive: true });
        const ts = Date.now();
        for (const [path, content] of snapshots) {
          const safeName = path.replace(/[\\/]/g, '__');
          writeFileSync(join(snapshotDir, `${ts}-${safeName}`), content, 'utf-8');
        }
      } catch {
        // 快照落盘失败不阻塞主流程（内存快照仍可用于本次回滚）
      }
    }

    for (const file of patch.files) {
      const content = results.get(file.path) ?? '';
      if (file.op === 'delete') {
        workspace.deleteFile(file.path);
      } else {
        workspace.writeFile(file.path, content);
      }
    }
    applied = true;

    // Phase 3：构建结果
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (const file of patch.files) {
      before[file.path] = snapshots.get(file.path) ?? '';
      after[file.path] = results.get(file.path) ?? '';
    }
    return { before, after, snapshots };
  } catch (err) {
    if (applied) {
      // 写入阶段失败：回滚到快照
      for (const [path, snapshot] of snapshots) {
        workspace.writeFile(path, snapshot);
      }
      throw new MoziError(
        ErrorCodes.ERR_TOOL_INTERNAL,
        `patch applied but write failed, rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
}
