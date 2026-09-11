// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'payments.js'),
  `export function processPayment({ method, amount }) {
  // TODO: if-else 链改表驱动（行为不变）
  if (method === 'card') {
    const fee = amount * 0.03;
    if (fee < 0.3) {
      return { ok: true, method, amount, fee: 0.3, total: amount + 0.3 };
    }
    return { ok: true, method, amount, fee: Number(fee.toFixed(2)), total: Number((amount + fee).toFixed(2)) };
  } else if (method === 'wallet') {
    const fee = 0;
    return { ok: true, method, amount, fee, total: amount };
  } else if (method === 'bank') {
    if (amount < 100) {
      return { ok: false, reason: 'bank_requires_min_100' };
    }
    const fee = 1;
    return { ok: true, method, amount, fee, total: amount + 1 };
  }
  return { ok: false, reason: 'unsupported_method' };
}
`,
);
