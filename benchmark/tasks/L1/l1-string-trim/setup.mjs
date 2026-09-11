// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'normalize.js'),
  `/**
 * 规范化用户名：去首尾空白 + 内部连续空白压缩为单空格。
 */
export function normalizeName(name) {
  // BUG: 完全没有做任何清理
  return name;
}
`,
);
