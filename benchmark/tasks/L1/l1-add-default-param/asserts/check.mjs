// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { toRect } = await import(pathToFileURL(join(process.argv[2], 'rect.js')));

assert.deepEqual(toRect(), { width: 100, height: 50, area: 5000 }, '全默认');
assert.deepEqual(toRect(200), { width: 200, height: 50, area: 10000 }, '只传 width');
assert.deepEqual(toRect(200, 80), { width: 200, height: 80, area: 16000 }, '显式全传');
assert.deepEqual(toRect(0, 0), { width: 0, height: 0, area: 0 }, '显式 0 不被默认值覆盖');

console.log('l1-add-default-param: OK');
