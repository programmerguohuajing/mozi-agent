// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'db'), { recursive: true });

writeFileSync(
  join(dir, 'db', 'query.js'),
  `const users = {
  u1: { id: 'u1', name: 'alice' },
  u2: { id: 'u2', name: 'bob' },
};

export const stats = { queries: 0 };

export async function fetchUser(id) {
  stats.queries += 1;
  await new Promise((r) => setTimeout(r, 5));
  return users[id] ?? null;
}
`,
);
