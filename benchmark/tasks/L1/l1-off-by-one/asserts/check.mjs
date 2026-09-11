// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { paginate } = await import(pathToFileURL(join(process.argv[2], 'paginate.js')));

const list = [1, 2, 3, 4, 5];

assert.deepEqual(paginate(list, 1, 2).data, [1, 2], '第 1 页应恰好 2 个元素');
assert.deepEqual(paginate(list, 2, 2).data, [3, 4], '第 2 页应恰好 2 个元素');
assert.deepEqual(paginate(list, 3, 2).data, [5], '最后一页返回剩余元素');
assert.equal(paginate(list, 1, 2).pageCount, 3, 'pageCount 正确');
assert.deepEqual(paginate(list, 1, 10).data, list, 'size 大于列表时返回全部');
assert.deepEqual(paginate(list, 99, 2).data, [], '越界页返回空数组');

console.log('l1-off-by-one: OK');
