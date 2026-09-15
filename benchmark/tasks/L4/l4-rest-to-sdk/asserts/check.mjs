// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 已迁移到 SDK
const src = readFileSync(join(dir, 'api', 'client.js'), 'utf8');
assert.ok(src.includes('ResourceClient'), 'client.js 应使用 ResourceClient');
assert.ok(!/await fetch\(/.test(src), 'client.js 不应再手写 fetch');

// 捕获全局 fetch 验证行为等价
const calls = [];
const fakeJson = async () => ({ ok: true });
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
  return { json: fakeJson };
};

const client = await import(pathToFileURL(join(dir, 'api', 'client.js')));

await client.getUser(42);
await client.listUsers();
await client.createOrder({ sku: 'A1', qty: 2 });
await client.updateOrder(9, { qty: 3 });

assert.equal(calls.length, 4, '四个方法各发一次请求');
assert.deepEqual(
  calls[0],
  {
    url: 'https://api.example.com/v1/users/42',
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_123' },
    body: undefined,
  },
  'getUser：URL/方法/头/体一致',
);
assert.deepEqual(calls[1].url, 'https://api.example.com/v1/users', 'listUsers URL');
assert.equal(calls[1].method, 'GET');
assert.deepEqual(
  calls[2],
  {
    url: 'https://api.example.com/v1/orders',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_123' },
    body: JSON.stringify({ sku: 'A1', qty: 2 }),
  },
  'createOrder：POST + JSON 序列化体',
);
assert.deepEqual(
  calls[3],
  {
    url: 'https://api.example.com/v1/orders/9',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_123' },
    body: JSON.stringify({ qty: 3 }),
  },
  'updateOrder：PUT',
);

console.log('l4-rest-to-sdk: OK');
