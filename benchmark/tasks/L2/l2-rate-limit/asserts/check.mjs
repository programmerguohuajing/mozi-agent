// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { RateLimiter } = await import(pathToFileURL(join(process.argv[2], 'rate-limit.js')));

const rl = new RateLimiter({ max: 2, windowMs: 80 });

assert.deepEqual(rl.acquire('a'), { allowed: true, remaining: 1 }, '第 1 次放行');
assert.equal(rl.acquire('a').allowed, true, '第 2 次放行');
const blocked = rl.acquire('a');
assert.equal(blocked.allowed, false, '第 3 次拒绝');
assert.equal(blocked.remaining, 0);
assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 80, '给出重试等待毫秒数');

assert.equal(rl.acquire('b').allowed, true, '不同 key 互不影响');

rl.reset('a');
assert.equal(rl.acquire('a').allowed, true, 'reset 后恢复');

await sleep(90);
assert.equal(rl.acquire('a').allowed, true, '窗口过期自动恢复');
assert.equal(rl.acquire('a').remaining, 0, '新窗口重新计数');

assert.throws(() => new RateLimiter({ max: 0, windowMs: 100 }), '非法构造参数抛错');

console.log('l2-rate-limit: OK');
