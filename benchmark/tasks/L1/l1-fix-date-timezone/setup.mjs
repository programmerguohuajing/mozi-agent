// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'utils'), { recursive: true });

writeFileSync(
  join(dir, 'utils', 'date.js'),
  `/**
 * 把日期格式化为面向本地用户的显示字符串：YYYY-MM-DD HH:mm
 */
export function formatDate(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  // BUG: 这里用了 UTC 取值，但函数语义是本地时间显示
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
`,
);
