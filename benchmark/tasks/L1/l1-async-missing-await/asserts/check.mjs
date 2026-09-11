// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { loadProfile } = await import(pathToFileURL(join(process.argv[2], 'profile.js')));

const p1 = await loadProfile('u1');
assert.equal(p1.name, 'alice', '应返回解析后的资料对象');
assert.equal(p1.role, 'admin');

const p2 = await loadProfile('missing');
assert.equal(p2, null, '不存在的用户返回 null');

console.log('l1-async-missing-await: OK');
