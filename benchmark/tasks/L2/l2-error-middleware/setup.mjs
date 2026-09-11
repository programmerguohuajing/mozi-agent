// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'handlers'), { recursive: true });

writeFileSync(
  join(dir, 'handlers', 'get-user.js'),
  `export async function getUser(ctx) {
  if (ctx.params.id === 'boom') {
    throw new Error('db exploded');
  }
  return { status: 200, body: { id: ctx.params.id, name: 'alice' } };
}
`,
);

writeFileSync(
  join(dir, 'handlers', 'delete-user.js'),
  `export async function deleteUser(ctx) {
  if (!ctx.params.id) {
    // TODO: 应返回 404 NOT_FOUND，而不是 500
    throw new Error('missing id');
  }
  return { status: 200, body: { deleted: ctx.params.id } };
}
`,
);

writeFileSync(
  join(dir, 'server.js'),
  `// TODO: 用 withErrorHandling 统一包装两个 handler，消除重复 try-catch
import { getUser } from './handlers/get-user.js';
import { deleteUser } from './handlers/delete-user.js';

export const routes = {
  'GET /users/:id': async (ctx) => {
    try {
      return await getUser(ctx);
    } catch (e) {
      return { status: 500, body: { error: { code: 'INTERNAL', message: String(e.message) } } };
    }
  },
  'DELETE /users/:id': async (ctx) => {
    try {
      return await deleteUser(ctx);
    } catch (e) {
      return { status: 500, body: { error: { code: 'INTERNAL', message: String(e.message) } } };
    }
  },
};
`,
);
