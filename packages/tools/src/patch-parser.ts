/**
 * Patch parser —— 状态机解析 `*** Begin Patch` 语法（M3 §3.5.2）。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
// ── Public types ────────────────────────────────────────────────

export type FileOpType = 'update' | 'add' | 'delete';

export interface PatchHunk {
  signature: string[];    // context + delete 行（去前缀），用于匹配定位
  additions: string[];    // + 行（去前缀）
}

export interface PatchFile {
  op: FileOpType;
  path: string;
  hunks?: PatchHunk[];   // Update
  body?: string[];        // Add（去 + 前缀）
}

export interface Patch {
  files: PatchFile[];
}

// ── Errors ──────────────────────────────────────────────────────

export class PatchParseError extends MoziError {
  constructor(message: string, line?: number) {
    super(
      ErrorCodes.ERR_PATCH_PARSE,
      line != null ? `line ${line + 1}: ${message}` : message,
      true,
    );
  }
}

// ── Parser ──────────────────────────────────────────────────────

const BEGIN_MARKER = '*** Begin Patch';
const END_MARKER = '*** End Patch';
const FILE_OP_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const HUNK_LINE_RE = /^([ +-])(.*)$/;

export function parsePatch(text: string): Patch {
  const lines = text.split('\n');
  const files: PatchFile[] = [];
  let i = 0;

  // 1. 定位 Begin
  while (i < lines.length && (lines[i] ?? '').trim() !== BEGIN_MARKER) i++;
  if (i >= lines.length) throw new PatchParseError('Missing "*** Begin Patch"');
  i++;

  // 2. 定位 End
  let endIdx = i;
  while (endIdx < lines.length && (lines[endIdx] ?? '').trim() !== END_MARKER) endIdx++;
  if (endIdx >= lines.length) throw new PatchParseError('Missing "*** End Patch"');

  // 3. 解析文件操作
  while (i < endIdx) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') { i++; continue; }

    const fileOpMatch = FILE_OP_RE.exec(trimmed);
    if (!fileOpMatch) {
      throw new PatchParseError(`Unexpected line: "${trimmed.slice(0, 60)}"`, i);
    }

    const opName = fileOpMatch[1]!;
    const op: FileOpType =
      opName === 'Update' ? 'update' : opName === 'Add' ? 'add' : 'delete';
    const path = fileOpMatch[2]!.trim();
    i++;

    const file: PatchFile = { op, path };

    if (op === 'update') {
      const result = extractHunksFrom(lines, i, endIdx);
      file.hunks = result.hunks;
      i = result.nextIndex;
    } else if (op === 'add') {
      file.body = [];
      while (i < endIdx) {
        const l = lines[i] ?? '';
        const m = HUNK_LINE_RE.exec(l);
        if (m && m[1] === '+') {
          file.body!.push(m[2]!);
          i++;
        } else if (l.trim() === '') {
          // peek: 下一个非空行如果是 FileOp 或 End，说明 body 结束
          let peek = i + 1;
          while (peek < endIdx && (lines[peek] ?? '').trim() === '') peek++;
          if (peek < endIdx) {
            const pl = lines[peek] ?? '';
            if (FILE_OP_RE.test(pl.trim()) || pl.trim() === END_MARKER) break;
          }
          i++;
        } else {
          break;
        }
      }
    } else {
      // delete：无正文，直接跳过
      i++;
    }

    files.push(file);
  }

  if (files.length === 0) throw new PatchParseError('Patch contains no file operations');
  if (files.length > 10) throw new PatchParseError('Patch exceeds maximum of 10 files', i);

  return { files };
}

interface HunkResult {
  hunks: PatchHunk[];
  nextIndex: number;
}

function extractHunksFrom(lines: string[], start: number, end: number): HunkResult {
  const hunks: PatchHunk[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // 到达新文件操作或 End，停止
    if (FILE_OP_RE.test(trimmed) || trimmed === END_MARKER) break;

    // hunk 锚点行（@@ ...）：仅提示作用，跳过
    if (line.startsWith('@@')) {
      i++;
      continue;
    }

    // 空行：可能分隔 hunk 或结束 hunks
    if (trimmed === '') {
      let peek = i + 1;
      while (peek < end && (lines[peek] ?? '').trim() === '') peek++;
      if (peek < end) {
        const pl = lines[peek] ?? '';
        if (FILE_OP_RE.test(pl.trim()) || pl.trim() === END_MARKER) {
          i++;
          break;
        }
      }
      i++;
      continue;
    }

    // 收集一个 hunk
    const sig: string[] = [];
    const adds: string[] = [];

    while (i < end) {
      const l = lines[i] ?? '';
      const m = HUNK_LINE_RE.exec(l);

      if (!m) break; // 非 hunk 行

      const prefix = m[1]!;
      const content = m[2]!;

      if (prefix === ' ') {
        sig.push(content);
      } else if (prefix === '-') {
        sig.push(content);
      } else if (prefix === '+') {
        adds.push(content);
      } else {
        throw new PatchParseError(`Invalid hunk prefix '${prefix}'`, i);
      }
      i++;

      // 终止条件：看到 context 行（说明 additions 段结束）
      if (adds.length > 0 && sig.length > 0) {
        const nextLine = lines[i] ?? '';
        if (!nextLine) break;
        const nextM = HUNK_LINE_RE.exec(nextLine);
        if (nextM && nextM[1] === ' ') break;
        const nt = nextLine.trim();
        if (FILE_OP_RE.test(nt) || nt === END_MARKER) break;
        if (nt === '') break;
      }
    }

    if (sig.length > 0 || adds.length > 0) {
      hunks.push({ signature: sig, additions: adds });
    } else {
      break;
    }
  }

  return { hunks, nextIndex: i };
}
