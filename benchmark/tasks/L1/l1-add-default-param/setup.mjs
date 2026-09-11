// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'rect.js'),
  `/**
 * 构造矩形描述对象。
 */
export function toRect(width, height) {
  return { width, height, area: width * height };
}
`,
);
