/**
 * Diff 审阅的跨进程类型契约（主进程 DiffReviewService 与渲染进程共用）。
 * 纯类型，无 Node 依赖，故可被 renderer tsconfig 直接包含。
 */

export type HunkKind = 'replace' | 'add' | 'delete';

/** 一个逻辑变更块（Monaco line decorations 关联单元）。 */
export interface DiffHunkView {
  /** 稳定 id（`h${n}`），UI 勾选与部分应用用它。 */
  id: string;
  kind: HunkKind;
  /** 旧文件行范围 [startLine, endLine)，1-based。 */
  oldRange: { startLine: number; endLine: number };
  /** 新文件行范围 [startLine, endLine)，1-based。 */
  newRange: { startLine: number; endLine: number };
  /** 旧侧行内容（删除/被替换行）。 */
  oldLines: string[];
  /** 新侧行内容（新增/替换行）。 */
  newLines: string[];
}

/** Monaco 可消费的 side-by-side 模型。 */
export interface DiffSideBySide {
  file: string;
  before: string[];
  after: string[];
  hunks: DiffHunkView[];
  stats: { additions: number; deletions: number };
}
