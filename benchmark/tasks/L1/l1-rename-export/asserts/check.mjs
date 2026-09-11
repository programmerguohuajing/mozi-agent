// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const dataSrc = readFileSync(join(dir, 'lib', 'data.js'), 'utf8');
const appSrc = readFileSync(join(dir, 'app.js'), 'utf8');

assert.ok(!dataSrc.includes('getUserData'), 'lib/data.js 不得再包含旧名 getUserData');
assert.ok(!appSrc.includes('getUserData'), 'app.js 不得再引用旧名 getUserData');
assert.ok(dataSrc.includes('fetchUserProfile'), 'lib/data.js 应导出 fetchUserProfile');

const data = await import(pathToFileURL(join(dir, 'lib', 'data.js')));
assert.equal(typeof data.fetchUserProfile, 'function', 'fetchUserProfile 已导出');
assert.equal(data.getUserData, undefined, '旧名不得再导出');

const app = await import(pathToFileURL(join(dir, 'app.js')));
assert.equal(app.greet(1), 'hello, alice', '调用处行为保持');
assert.equal(app.label(2), 'user#2');
assert.equal(app.greet(99), 'hello, stranger');

console.log('l1-rename-export: OK');
