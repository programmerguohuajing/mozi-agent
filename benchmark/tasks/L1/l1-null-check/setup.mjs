// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'address.js'),
  `/**
 * 取用户所在城市；无地址信息时返回 undefined。
 */
export function getCity(user) {
  // BUG: 无空值防护
  return user.address.city;
}
`,
);
