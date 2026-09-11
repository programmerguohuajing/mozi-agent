// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'store'), { recursive: true });
mkdirSync(join(dir, 'api'), { recursive: true });

writeFileSync(
  join(dir, 'store', 'users.js'),
  `export const users = Array.from({ length: 55 }, (_, i) => ({
  id: i + 1,
  name: 'user' + (i + 1),
}));
`,
);

writeFileSync(
  join(dir, 'api', 'users.js'),
  `import { users } from '../store/users.js';

// TODO: 加分页参数 { page = 1, limit = 20 }，返回 { data, page, limit, total }
export function listUsers() {
  return { data: users.slice() };
}
`,
);
