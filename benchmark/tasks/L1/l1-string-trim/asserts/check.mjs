// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { normalizeName } = await import(pathToFileURL(join(process.argv[2], 'normalize.js')));

assert.equal(normalizeName('  alice '), 'alice', '去首尾空白');
assert.equal(normalizeName('alice   bob'), 'alice bob', '内部连续空白压缩');
assert.equal(normalizeName('\t alice \n'), 'alice', '处理制表符与换行');
assert.equal(normalizeName('   '), '', '全空白输入返回空串');
assert.equal(normalizeName('alice'), 'alice', '正常输入不受影响');

console.log('l1-string-trim: OK');
