/**
 * 轻量 glob 工具（零依赖）。供 tools/glob 与 policy 路径匹配共用。
 * 支持：** 匹配任意层级（含 /）、* 匹配除 / 外任意字符、? 匹配单个非 / 字符、
 *       {a,b} 花括号展开（可嵌套，逗号在花括号内为分隔符）。
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${toRegExpSource(pattern)}$`);
}

function toRegExpSource(pattern: string): string {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === '{') {
      const close = findMatchingBrace(pattern, i);
      if (close < 0) {
        // 未闭合的花括号按字面量处理
        re += '\\{';
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alts = splitTopLevel(inner, ',');
      re += `(?:${alts.map(toRegExpSource).join('|')})`;
      i = close + 1;
      continue;
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i++;
  }
  return re;
}

/** 找到与 pattern[open] 匹配的闭花括号下标（支持嵌套）；未闭合返回 -1。 */
function findMatchingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层分隔符拆分（忽略嵌套花括号内的分隔符）。 */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}
