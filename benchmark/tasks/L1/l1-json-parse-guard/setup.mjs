// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'json.js'),
  `/**
 * 安全解析 JSON：失败返回 null。
 */
export function safeParse(text) {
  // BUG: 没有 try-catch，非法 JSON 直接抛异常
  return JSON.parse(text);
}
`,
);
