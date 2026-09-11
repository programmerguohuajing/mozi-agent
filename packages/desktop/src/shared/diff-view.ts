/**
 * Diff 视图派生纯函数（M10 §10.5③）。
 *
 * 与 `diff-types.ts` 一样放在 `shared/` 下：**不依赖 Node / React**，
 * 因此主进程（可单测）与渲染进程（DiffReviewer）都能引用同一份实现，
 * 避免「语言推断 / decoration 计算」出现两套逻辑。
 */
import type { DiffHunkView } from './diff-types.js';

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  css: 'css',
  scss: 'scss',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
};

/** 由文件扩展名推断 Monaco 语言 id（未知 → plaintext）。 */
export function languageFor(file: string): string {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = file.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

export interface HunkDecoration {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  options: { className: string; hoverMessage: { value: string } };
}

export interface HunkDecorationSet {
  original: HunkDecoration[];
  modified: HunkDecoration[];
}

/** hunk kind → CSS 类名（渲染器据此上色）。 */
export function hunkClassName(kind: DiffHunkView['kind']): string {
  return kind === 'add' ? 'hunk-add' : kind === 'delete' ? 'hunk-del' : 'hunk-replace';
}

/**
 * 计算 hunk 的 decorations（关联 hunk id），供 Monaco `deltaDecorations` 使用。
 * 纯新增 / 纯删除时对应侧为插入点（start === end），仍给出 1 行宽以便显示装饰。
 */
export function hunkDecorations(hunks: DiffHunkView[]): HunkDecorationSet {
  const original: HunkDecoration[] = [];
  const modified: HunkDecoration[] = [];
  for (const h of hunks) {
    const cls = hunkClassName(h.kind);
    const hover = { value: `${h.id} (${h.kind})` };
    const oStart = h.oldRange.startLine;
    const oEnd = Math.max(h.oldRange.endLine, oStart + 1);
    original.push({
      range: { startLineNumber: oStart, startColumn: 1, endLineNumber: oEnd, endColumn: 1 },
      options: { className: cls, hoverMessage: hover },
    });
    const nStart = h.newRange.startLine;
    const nEnd = Math.max(h.newRange.endLine, nStart + 1);
    modified.push({
      range: { startLineNumber: nStart, startColumn: 1, endLineNumber: nEnd, endColumn: 1 },
      options: { className: cls, hoverMessage: hover },
    });
  }
  return { original, modified };
}
