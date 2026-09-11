// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'highlight.js'),
  `/**
 * 把 text 中出现的 term 片段包裹为 <mark>term</mark>（字面量匹配）。
 */
export function highlight(text, term) {
  if (!term) return text;
  // BUG: term 未转义，含正则特殊字符时抛异常
  const re = new RegExp(term, 'g');
  return text.replace(re, (m) => '<mark>' + m + '</mark>');
}
`,
);
