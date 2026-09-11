/**
 * Diff 审阅器（M10 §10.5③）——Monaco DiffEditor 封装。
 *
 * Monaco 由宿主在运行时以 `monaco` 注入（避免静态依赖 monaco-editor 的巨型类型与包体）。
 * 本组件负责：
 *   - 用 `DiffSideBySide` 模型（before/after 行 + hunks）驱动 Monaco side-by-side；
 *   - 把每个 hunk 映射为 line decorations（关联 hunk id）；
 *   - 用户勾选 hunk → 仅应用选中项（引擎的 `diff:applyPartial`）。
 */
import * as React from 'react';
import type { DiffHunkView, DiffSideBySide } from '../../shared/diff-types.js';
import { hunkDecorations, languageFor } from '../../shared/diff-view.js';
export { hunkDecorations, languageFor };

/** Monaco 最小接口（宿主注入实现，通常是 `monaco.editor`）。 */
export interface MonacoLike {
  createDiffEditor(
    container: HTMLElement,
    opts: Record<string, unknown>,
  ): {
    setModel(original: unknown, modified: unknown): void;
    getOriginalEditor(): { deltaDecorations(old: string[], next: unknown[]): string[] };
    getModifiedEditor(): { deltaDecorations(old: string[], next: unknown[]): string[] };
    dispose(): void;
  };
  createModel(content: string, language: string): unknown;
  createDecorationType(opts: Record<string, unknown>): unknown;
  editor?: unknown;
}

export interface DiffReviewerProps {
  model: DiffSideBySide;
  /** Monaco 命名空间（运行时注入）。 */
  monaco: MonacoLike;
  /** 语言标识（按扩展名推断，缺省 plaintext）。 */
  language?: string;
  onApply: (hunkIds: string[]) => void;
}

export function DiffReviewer(props: DiffReviewerProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const selectedRef = React.useRef<Set<string>>(new Set<string>());
  const [, force] = React.useState(0);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const diff = props.monaco.createDiffEditor(containerRef.current, {
      readOnly: true,
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
    });
    const lang = props.language ?? languageFor(props.model.file);
    const original = props.monaco.createModel(props.model.before.join('\n'), lang);
    const modified = props.monaco.createModel(props.model.after.join('\n'), lang);
    diff.setModel(original, modified);
    const decos = hunkDecorations(props.model.hunks);
    diff.getOriginalEditor().deltaDecorations([], decos.original);
    diff.getModifiedEditor().deltaDecorations([], decos.modified);
    return () => diff.dispose();
  }, [props.model, props.monaco, props.language]);

  const selected = (): Set<string> => selectedRef.current ?? new Set<string>();

  const toggle = (id: string): void => {
    const set = selected();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    force((n) => n + 1);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-700 px-3 py-2 text-xs">
        <span className="font-mono">{props.model.file}</span>
        <span className="text-emerald-400">+{props.model.stats.additions}</span>
        <span className="text-red-400">-{props.model.stats.deletions}</span>
        <button
          className="ml-auto rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-500"
          onClick={() => props.onApply([...selected()])}
          disabled={selected().size === 0}
        >
          应用选中 hunk（{selected().size}）
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-auto border-r border-neutral-700 p-2">
          {props.model.hunks.map((h) => (
            <label key={h.id} className="flex cursor-pointer items-start gap-2 py-1 text-xs">
              <input type="checkbox" checked={selected().has(h.id)} onChange={() => toggle(h.id)} />
              <span>
                <span className="font-mono text-neutral-300">{h.id}</span>{' '}
                <span className="text-neutral-500">{h.kind}</span>
                <br />
                <span className="text-neutral-500">
                  L{h.oldRange.startLine}-{h.oldRange.endLine} → L{h.newRange.startLine}-
                  {h.newRange.endLine}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div ref={containerRef} className="min-w-0 flex-1" />
      </div>
    </div>
  );
}
