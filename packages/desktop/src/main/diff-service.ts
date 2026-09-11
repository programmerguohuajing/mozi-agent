/**
 * Diff 审阅服务（M10 §10.5③）。
 *
 * 把 edit_file / patch 的 before→after 转成 Monaco DiffEditor 可消费的模型：
 *   - `DiffSideBySide`：左右行数组 + 变更区间（供 decorations 上色）；
 *   - `DiffHunkView`：每个逻辑变更块带稳定 `id` + 行范围，供逐 hunk 批准；
 *   - `applyPartial(file, hunkIds)`：只应用用户勾选的 hunk（PatchEngine 增量入口）。
 *
 * 算法：基于「最小编辑脚本」的 LCS 行 diff，得到 replace/add/delete 变更块后
 * 按间隙聚合为 hunk。零依赖、确定性输出（可快照测试）。
 */
import type { PartialApplyRequest } from '@mozi/protocol';
import type { DiffHunkView, DiffSideBySide, HunkKind } from '../shared/diff-types.js';

export type { DiffHunkView, DiffSideBySide, HunkKind };

export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/** 最小编辑脚本（LCS 动态规划）。返回按序操作：'=' 保留 / '-' 删除 / '+' 新增。 */
export function diffScript(oldLines: string[], newLines: string[]): Array<['=' | '-' | '+', string]> {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i]!;
      if (oldLines[i] === newLines[j]) {
        row[j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }
  const ops: Array<['=' | '-' | '+', string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push(['=', oldLines[i]!]);
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push(['-', oldLines[i]!]);
      i++;
    } else {
      ops.push(['+', newLines[j]!]);
      j++;
    }
  }
  while (i < n) ops.push(['-', oldLines[i++]!]);
  while (j < m) ops.push(['+', newLines[j++]!]);
  return ops;
}

/**
 * 把编辑脚本聚合为 hunk：连续的 `-`/`+` 段合为一个变更块；
 * 相邻变更块之间若只隔少量上下文行，则并入同一块（gap ≤ context 行）。
 */
export function buildHunks(
  ops: Array<['=' | '-' | '+', string]>,
  context = 0,
): DiffHunkView[] {
  const hunks: DiffHunkView[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  let seq = 0;

  while (i < ops.length) {
    if (ops[i]![0] === '=') {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // 收集一个变更块的旧/新行
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const oldStart = oldLine;
    const newStart = newLine;
    let gapBudget = context;

    while (i < ops.length) {
      const op = ops[i]!;
      if (op[0] === '=') {
        // 允许跨过至多 context 行上下文继续合并
        let ctx = 0;
        let k = i;
        while (k < ops.length && ops[k]![0] === '=') {
          ctx++;
          k++;
        }
        if (k < ops.length && ctx <= gapBudget) {
          for (let g = i; g < k; g++) {
            oldLines.push(ops[g]![1]);
            newLines.push(ops[g]![1]);
            oldLine++;
            newLine++;
          }
          i = k;
          gapBudget -= ctx;
          continue;
        }
        break;
      }
      if (op[0] === '-') {
        oldLines.push(op[1]);
        oldLine++;
      } else {
        newLines.push(op[1]);
        newLine++;
      }
      i++;
    }

    const id = `h${++seq}`;
    const kind: HunkKind =
      oldLines.length === 0 ? 'add' : newLines.length === 0 ? 'delete' : 'replace';
    hunks.push({
      id,
      kind,
      oldRange: { startLine: oldStart, endLine: oldLine },
      newRange: { startLine: newStart, endLine: newLine },
      oldLines,
      newLines,
    });
  }
  return hunks;
}

/** 构建 Monaco side-by-side 模型（§10.5③）。 */
export function buildSideBySide(file: string, before: string, after: string, context = 0): DiffSideBySide {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = diffScript(oldLines, newLines);
  const hunks = buildHunks(ops, context);
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    additions += h.newLines.length;
    deletions += h.oldLines.length;
  }
  return { file, before: oldLines, after: newLines, hunks, stats: { additions, deletions } };
}

/**
 * 部分应用：只把指定 hunk 应用到 before，返回结果内容。
 * 未勾选的 hunk 保持旧内容（§10.5③「仅应用该 hunk」）。
 */
export function applyHunksToContent(before: string, hunks: DiffHunkView[], ids: string[]): string {
  const selected = new Set(ids);
  const beforeLines = splitLines(before);
  const out: string[] = [];
  let cursor = 0; // 旧文件已消费行数（0-based）
  for (const h of hunks) {
    const oldStart = h.oldRange.startLine - 1;
    const oldEnd = h.oldRange.endLine - 1;
    // 保留未变更区
    while (cursor < oldStart) {
      out.push(beforeLines[cursor] ?? '');
      cursor++;
    }
    if (selected.has(h.id)) {
      out.push(...h.newLines);
      cursor = oldEnd;
    } else {
      // 未选中：原样保留旧行
      for (let k = oldStart; k < oldEnd; k++) out.push(beforeLines[k] ?? '');
      cursor = oldEnd;
    }
  }
  while (cursor < beforeLines.length) {
    out.push(beforeLines[cursor] ?? '');
    cursor++;
  }
  return out.join('\n');
}

export interface DiffReviewServiceDeps {
  /** 读取文件当前内容（workspace 边界校验由调用方保证）。 */
  readFile: (file: string) => string | null;
  /** 写入文件。 */
  writeFile: (file: string, content: string) => void;
}

/** 记录会话内最近一次 diff（供 UI 拉取与部分应用）。 */
interface PendingDiff {
  sessionId: string;
  model: DiffSideBySide;
}

export class DiffReviewService {
  private readonly pending = new Map<string, PendingDiff>();

  constructor(private readonly deps: DiffReviewServiceDeps) {}

  /** 记录一次变更（edit_file / patch 应用后由主进程调用）。 */
  record(sessionId: string, file: string, before: string, after: string): DiffSideBySide {
    const model = buildSideBySide(file, before, after, 0);
    this.pending.set(`${sessionId}::${file}`, { sessionId, model });
    return model;
  }

  /** 拉取最近一次 diff 模型。 */
  get(sessionId: string, file: string): DiffSideBySide | null {
    return this.pending.get(`${sessionId}::${file}`)?.model ?? null;
  }

  /** 逐 hunk 批准 → 仅写入选中 hunk（§10.5③）。 */
  applyPartial(req: PartialApplyRequest): { ok: boolean; applied: number } {
    const entry = this.pending.get(`${req.sessionId}::${req.file}`);
    if (!entry) return { ok: false, applied: 0 };
    const before = this.deps.readFile(req.file);
    if (before == null) return { ok: false, applied: 0 };
    const ids = entry.model.hunks.filter((h) => req.hunkIds.includes(h.id)).map((h) => h.id);
    if (ids.length === 0) return { ok: false, applied: 0 };
    const next = applyHunksToContent(before, entry.model.hunks, ids);
    this.deps.writeFile(req.file, next);
    // 已应用部分：重算模型供后续继续批准（剩余 hunk 仍在）。
    const remaining = entry.model.hunks.filter((h) => !ids.includes(h.id));
    if (remaining.length === 0) this.pending.delete(`${req.sessionId}::${req.file}`);
    else {
      const refreshed = buildSideBySide(req.file, next, entry.model.after.join('\n'), 0);
      // 重新编号：保持与首次一致的 hunkId 便于 UI 跟踪。
      refreshed.hunks = remaining.map((h, i) => ({ ...h, id: h.id ?? `h${i + 1}` }));
      this.pending.set(`${req.sessionId}::${req.file}`, { sessionId: req.sessionId, model: refreshed });
    }
    return { ok: true, applied: ids.length };
  }

  /** 全部应用（一键接受）。 */
  applyAll(sessionId: string, file: string): { ok: boolean; applied: number } {
    const entry = this.pending.get(`${sessionId}::${file}`);
    if (!entry) return { ok: false, applied: 0 };
    return this.applyPartial({
      sessionId,
      file,
      hunkIds: entry.model.hunks.map((h) => h.id),
    });
  }

  /** 清理会话的 diff 记录。 */
  clear(sessionId: string): void {
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(`${sessionId}::`)) this.pending.delete(key);
    }
  }
}
