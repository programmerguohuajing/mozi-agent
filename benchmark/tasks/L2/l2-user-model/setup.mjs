// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'db.js'),
  `let nextId = 1;
const users = [];

// TODO: 拆成 models/user.js + repo/user-repo.js 两层
export function registerUser(input) {
  if (!input?.name || !input?.email) {
    throw new Error('name 与 email 必填');
  }
  const user = { id: nextId++, name: input.name, email: input.email, role: 'member', password: input.password };
  users.push(user);
  const { password, ...safe } = user;
  return safe;
}
`,
);
