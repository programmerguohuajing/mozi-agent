// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'api'), { recursive: true });

writeFileSync(
  join(dir, 'api', 'createUser.js'),
  `// TODO: 用 validate/ 管线替换下面手写的零散校验
export function createUser(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string' || body.name.length < 2 || body.name.length > 20) {
    errors.push({ field: 'name', message: 'name 必填且为 2-20 字符' });
  }
  if (!body.email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(body.email)) {
    errors.push({ field: 'email', message: 'email 非法' });
  }
  if (body.age !== undefined && (typeof body.age !== 'number' || body.age < 0)) {
    errors.push({ field: 'age', message: 'age 需为非负数字' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, user: { name: body.name, email: body.email, age: body.age ?? null } };
}
`,
);
