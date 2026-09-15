// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 结构性要求：if-else 分派链应消失
const src = readFileSync(join(dir, 'payments.js'), 'utf8');
assert.ok(!/else if/.test(src), '不应再有 else-if 分派链');
assert.ok(/handlers|strategies|registry/i.test(src), '应有策略表');

const { processPayment } = await import(pathToFileURL(join(dir, 'payments.js')));

// 行为不变式（与原实现对拍）
assert.deepEqual(processPayment({ method: 'card', amount: 100 }), {
  ok: true,
  method: 'card',
  amount: 100,
  fee: 3,
  total: 103,
});
assert.deepEqual(
  processPayment({ method: 'card', amount: 5 }),
  {
    ok: true,
    method: 'card',
    amount: 5,
    fee: 0.3,
    total: 5.3,
  },
  '手续费下限 0.3',
);
assert.deepEqual(processPayment({ method: 'card', amount: 10 }), {
  ok: true,
  method: 'card',
  amount: 10,
  fee: 0.3,
  total: 10.3,
});
assert.deepEqual(processPayment({ method: 'wallet', amount: 77 }), {
  ok: true,
  method: 'wallet',
  amount: 77,
  fee: 0,
  total: 77,
});
assert.deepEqual(processPayment({ method: 'bank', amount: 200 }), {
  ok: true,
  method: 'bank',
  amount: 200,
  fee: 1,
  total: 201,
});
assert.deepEqual(
  processPayment({ method: 'bank', amount: 99 }),
  {
    ok: false,
    reason: 'bank_requires_min_100',
  },
  'bank 下限 100',
);
assert.deepEqual(
  processPayment({ method: 'crypto', amount: 1 }),
  {
    ok: false,
    reason: 'unsupported_method',
  },
  '未注册方式拒绝',
);

console.log('l4-strategy-payments: OK');
