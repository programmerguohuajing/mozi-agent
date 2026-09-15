/**
 * Patch matcher —— 多锚点贪心 + 回溯降级算法（M3 §3.5.3）。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { PatchFile, PatchHunk } from './patch-parser.js';

export interface MatchLocation {
  file: string;
  hunkIdx: number;
  start: number; // 匹配起始行（包含）
  end: number; // 匹配结束行（不包含）
}

export interface MatchDiagnostic {
  file: string;
  hunkIdx: number;
  expected: string[];
  found: string[];
  nearestLine: number;
}

export class PatchMatchError extends MoziError {
  constructor(diag: MatchDiagnostic) {
    super(
      ErrorCodes.ERR_PATCH_MISMATCH,
      `Mismatch in ${diag.file} hunk ${diag.hunkIdx}: expected [\n  ${diag.expected.join('\n  ')}\n], nearest found at line ${diag.nearestLine}: [\n  ${diag.found.join('\n  ')}\n]`,
      true,
      diag,
    );
  }
}

// 忽略行尾空白进行比较
function trimTrailing(s: string): string {
  return s.replace(/\s+$/, '');
}

/**
 * 在 lines[from..] 中查找 signature 的匹配位置。
 * 返回 [start, end) 或 null。
 */
export function matchHunk(
  lines: string[],
  hunk: PatchHunk,
  from: number,
): { location: MatchLocation } | { error: MatchDiagnostic } {
  const sig = hunk.signature;
  const L = sig.length;
  if (L === 0) {
    return {
      location: {
        file: '',
        hunkIdx: 0,
        start: from,
        end: from + hunk.additions.length,
      },
    };
  }

  const n = lines.length;
  const maxStart = n - L; // 最后一个合法起始位置

  // 正常扫描：逐行精确匹配（忽略行尾空白）
  for (let start = from; start <= maxStart; start++) {
    let match = true;
    for (let j = 0; j < L; j++) {
      const line = lines[start + j] ?? '';
      const sigLine = sig[j] ?? '';
      if (trimTrailing(line) !== trimTrailing(sigLine)) {
        match = false;
        break;
      }
    }
    if (match) {
      return {
        location: {
          file: '',
          hunkIdx: 0,
          start,
          end: start + L,
        },
      };
    }
  }

  // 降级：前缀匹配（只用前 3 行作为锚点）
  const prefixLen = Math.min(3, L);
  const prefix = sig.slice(0, prefixLen);
  let nearestDist = Number.POSITIVE_INFINITY;
  let nearestLine = -1;
  let nearestFound: string[] = [];

  for (let start = from; start <= Math.min(n - prefixLen, from + 50); start++) {
    let dist = 0;
    const found: string[] = [];
    for (let j = 0; j < prefixLen; j++) {
      const line = lines[start + j] ?? '';
      const pref = prefix[j] ?? '';
      if (trimTrailing(line) !== trimTrailing(pref)) {
        dist++;
      }
      found.push(line);
    }
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestLine = start;
      nearestFound = found;
    }
    if (dist === 0) break;
  }

  return {
    error: {
      file: '',
      hunkIdx: 0,
      expected: sig,
      found: nearestFound,
      nearestLine,
    },
  };
}

/**
 * 匹配文件的所有 hunks。
 * hunks 依序匹配：后一个 hunk 从前一个匹配的尾部开始搜索。
 */
export function matchFile(
  filePath: string,
  content: string,
  hunks: PatchHunk[],
): { locations: MatchLocation[] } | { error: MatchDiagnostic } {
  const lines = content.split('\n');
  const locations: MatchLocation[] = [];
  let prevEnd = 0;

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx];
    if (!hunk) continue;

    const result = matchHunk(lines, hunk, prevEnd);

    if ('error' in result) {
      return { error: { ...result.error, file: filePath, hunkIdx: hIdx } };
    }

    const loc = result.location;
    loc.file = filePath;
    loc.hunkIdx = hIdx;
    locations.push(loc);
    prevEnd = loc.end;
  }

  return { locations };
}

/**
 * 基于匹配位置计算应用后的行。
 * 替换签名行为 additions，context 行保留。
 */
export function applyLocations(
  lines: string[],
  hunks: PatchHunk[],
  locations: MatchLocation[],
): string[] {
  const rebuilt: string[] = [];
  let pos = 0;

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx];
    const loc = locations[hIdx];
    if (!hunk || !loc) continue;

    // 添加未覆盖的行
    while (pos < loc.start) {
      rebuilt.push(lines[pos] ?? '');
      pos++;
    }

    // 添加 additions
    rebuilt.push(...hunk.additions);

    // 跳过签名行（loc.start ~ loc.end）
    pos = loc.end;
  }

  // 添加剩余行
  while (pos < lines.length) {
    rebuilt.push(lines[pos] ?? '');
    pos++;
  }

  return rebuilt;
}
