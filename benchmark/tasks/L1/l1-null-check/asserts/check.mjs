// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { getCity } = await import(pathToFileURL(join(process.argv[2], 'address.js')));

assert.equal(getCity(null), undefined, 'null 输入不抛错');
assert.equal(getCity(undefined), undefined, 'undefined 输入不抛错');
assert.equal(getCity({}), undefined, '缺 address 不抛错');
assert.equal(getCity({ address: {} }), undefined, '缺 city 返回 undefined');
assert.equal(getCity({ address: { city: 'Beijing' } }), 'Beijing', '正常路径不变');

console.log('l1-null-check: OK');
