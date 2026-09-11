// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { listUsers } = await import(pathToFileURL(join(process.argv[2], 'api/users.js')));

const d = listUsers();
assert.equal(d.data.length, 20, '默认 limit=20');
assert.equal(d.page, 1, '默认 page=1');
assert.equal(d.limit, 20);
assert.equal(d.total, 55, 'total 为总数');

const p3 = listUsers({ page: 3 });
assert.equal(p3.data.length, 15, '最后一页返回剩余 15 条');
assert.equal(p3.data[0].id, 41);

const p99 = listUsers({ page: 99 });
assert.deepEqual(p99.data, [], '越界页返回空数组');
assert.equal(p99.total, 55, '越界页 total 仍是总数');

const lim = listUsers({ page: 1, limit: 10 });
assert.equal(lim.data.length, 10);
assert.equal(lim.limit, 10);

const capped = listUsers({ page: 1, limit: 500 });
assert.equal(capped.limit, 100, 'limit 上限 100');
assert.equal(capped.data.length, 55, '55 条数据全在第一页');

const bad = listUsers({ page: -1, limit: 'abc' });
assert.equal(bad.page, 1, '非法 page 回退默认');
assert.equal(bad.limit, 20, '非法 limit 回退默认');

console.log('l2-pagination: OK');
