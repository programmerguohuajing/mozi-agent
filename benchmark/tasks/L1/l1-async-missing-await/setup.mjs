// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'profile.js'),
  `const users = {
  u1: { id: 'u1', name: 'alice', role: 'admin' },
  u2: { id: 'u2', name: 'bob', role: 'member' },
};

async function fetchUser(userId) {
  await new Promise((r) => setTimeout(r, 5));
  return users[userId] ?? null;
}

/**
 * 返回用户资料对象；用户不存在返回 null。
 */
export async function loadProfile(userId) {
  // BUG: 漏了 await，user 是个 Promise
  const user = fetchUser(userId);
  return { name: user.name, role: user.role };
}
`,
);
