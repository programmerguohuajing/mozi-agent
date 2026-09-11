// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { safeParse } = await import(pathToFileURL(join(process.argv[2], 'json.js')));

assert.deepEqual(safeParse('{"a":1}'), { a: 1 }, '合法 JSON 正常解析');
assert.equal(safeParse('[1,2,3]')[2], 3, '数组解析');
assert.equal(safeParse('not json'), null, '非法 JSON 返回 null 而不是抛错');
assert.equal(safeParse('{"broken": '), null, '截断 JSON 返回 null');
assert.equal(safeParse(''), null, '空串返回 null');

console.log('l1-json-parse-guard: OK');
