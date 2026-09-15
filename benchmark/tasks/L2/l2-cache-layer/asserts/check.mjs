// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// TTLCache 单元行为
const { TTLCache } = await import(pathToFileURL(join(dir, 'cache/cache.js')));
const c = new TTLCache();
assert.equal(c.get('k'), undefined, '未设置读取为 undefined');
c.set('k', 'v', 50);
assert.equal(c.get('k'), 'v', '未过期可读取');
await sleep(60);
assert.equal(c.get('k'), undefined, '过期后读取为 undefined');
c.set('k2', 'v2', 10_000);
c.clear();
assert.equal(c.get('k2'), undefined, 'clear 清空');

// 接入后的 fetchUser
const { fetchUser, stats } = await import(pathToFileURL(join(dir, 'db/query.js')));
const before = stats.queries;
const a = await fetchUser('u1');
const b = await fetchUser('u1');
assert.equal(stats.queries - before, 1, '同一 id 两次调用只打一次底层');
assert.deepEqual(a, b, '两次返回一致');

await sleep(1050);
const d = await fetchUser('u1');
assert.equal(stats.queries - before, 2, 'TTL 过期后重新查询');
assert.equal(d.name, 'alice');

const e = await fetchUser('missing');
assert.equal(e, null, '未命中用户仍返回 null（原行为）');
assert.equal(stats.queries - before, 3);

console.log('l2-cache-layer: OK');
