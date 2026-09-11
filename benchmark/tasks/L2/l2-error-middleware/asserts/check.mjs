// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// server.js 不再手写重复 try-catch
const serverSrc = readFileSync(join(dir, 'server.js'), 'utf8');
assert.ok(!/try\s*{/.test(serverSrc), 'server.js 应交给中间件处理错误');
assert.ok(serverSrc.includes('withErrorHandling'), 'server.js 应使用 withErrorHandling');

const { routes } = await import(pathToFileURL(join(dir, 'server.js')));
const { HttpError } = await import(pathToFileURL(join(dir, 'handlers', 'http-error.js')));

// 正常路径
const ok = await routes['GET /users/:id']({ params: { id: 'u1' } });
assert.equal(ok.status, 200);
assert.equal(ok.body.id, 'u1');

// 普通异常 → 500 INTERNAL
const err = await routes['GET /users/:id']({ params: { id: 'boom' } });
assert.equal(err.status, 500, '普通异常映射 500');
assert.equal(err.body.error.code, 'INTERNAL');
assert.equal(err.body.error.message, 'db exploded');

// HttpError → 自定义状态码
const notFound = await routes['DELETE /users/:id']({ params: {} });
assert.equal(notFound.status, 404, 'HttpError 透传状态码');
assert.equal(notFound.body.error.code, 'NOT_FOUND');

const deleted = await routes['DELETE /users/:id']({ params: { id: 'u9' } });
assert.equal(deleted.status, 200);
assert.equal(deleted.body.deleted, 'u9');

// HttpError 类可独立使用
assert.ok(new HttpError(400, 'BAD', 'x') instanceof Error);

console.log('l2-error-middleware: OK');
