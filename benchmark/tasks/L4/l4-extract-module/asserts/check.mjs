// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 三个新模块存在
for (const f of ['lib/format.js', 'lib/http.js', 'lib/storage.js']) {
  assert.ok(existsSync(join(dir, f)), `${f} 应存在`);
}

// everything.js 变为 re-export（不再包含实现体）
const src = readFileSync(join(dir, 'lib', 'everything.js'), 'utf8');
assert.ok(src.includes('export'), 'everything.js 保持导出');
assert.ok(!/function formatDate/.test(src), '实现应移出 everything.js');
assert.ok(/from '\.\/format\.js'/.test(src), '应从 format.js 再导出');

// 对外 API 完整且行为不变
const api = await import(pathToFileURL(join(dir, 'lib', 'everything.js')));
assert.equal(typeof api.formatDate, 'function');
assert.equal(typeof api.formatMoney, 'function');
assert.equal(typeof api.httpGet, 'function');
assert.equal(typeof api.httpPost, 'function');
assert.equal(typeof api.save, 'function');
assert.equal(typeof api.load, 'function');

assert.equal(api.formatDate(new Date(2026, 8, 11)), '2026-09-11');
assert.equal(api.formatMoney(12345), '123.45 CNY');
assert.equal(api.formatMoney(9, 'USD'), '0.09 USD');
assert.deepEqual(await api.httpGet('/a'), { method: 'GET', url: '/a' });
assert.deepEqual(await api.httpPost('/b', { x: 1 }), { method: 'POST', url: '/b', body: { x: 1 } });
assert.equal(api.save('k', { v: 1 }), true);
assert.deepEqual(api.load('k'), { v: 1 });
assert.equal(api.load('missing'), undefined);

// 新模块可独立 import
const fmt = await import(pathToFileURL(join(dir, 'lib', 'format.js')));
assert.equal(fmt.formatMoney(1), '0.01 CNY');

console.log('l4-extract-module: OK');
