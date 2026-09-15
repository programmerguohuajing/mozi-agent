// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 源码不再直接 console.*
for (const f of ['service-a.js', 'service-b.js']) {
  const src = readFileSync(join(dir, f), 'utf8');
  assert.ok(!/console\./.test(src), `${f} 不得直接调用 console.*`);
  assert.ok(/createLogger/.test(src), `${f} 应使用 logger`);
}

// logger 行为（捕获输出）
const { createLogger, setLevel } = await import(pathToFileURL(join(dir, 'logger.js')));
const captured = [];
const orig = { log: console.log, error: console.error };
console.log = (m) => captured.push(String(m));
console.error = (m) => captured.push(String(m));
try {
  setLevel('info');
  const log = createLogger('x');
  log.debug('d0');
  log.info('i0');
  log.error('e0');
  setLevel('debug');
  log.debug('d1');
} finally {
  console.log = orig.log;
  console.error = orig.error;
}
assert.ok(!captured.some((l) => l.includes('d0')), '级别低于设定不输出');
assert.ok(
  captured.some((l) => l === '[INFO][x] i0'),
  'info 输出格式正确',
);
assert.ok(
  captured.some((l) => l === '[ERROR][x] e0'),
  'error 输出格式正确',
);
assert.ok(
  captured.some((l) => l.includes('d1')),
  '调低级别后 debug 恢复输出',
);

// service 行为不变
const a = await import(pathToFileURL(join(dir, 'service-a.js')));
const b = await import(pathToFileURL(join(dir, 'service-b.js')));
assert.equal(a.reserveSeat(5), true);
assert.equal(a.reserveSeat(0), false);
assert.equal(b.refundSeat(5), true);
assert.equal(b.refundSeat(-1), false);

console.log('l2-logging-module: OK');
