// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

writeFileSync(
  join(dir, 'src', 'cart.js'),
  `/**
 * 计算打 9 折后的购物车小计（两位小数）。
 */
export function subtotal(items) {
  // BUG: 原地修改了 item.price，污染调用方数据
  const discounted = items.map((item) => {
    item.price = item.price * 0.9;
    return item;
  });
  const total = discounted.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Number(total.toFixed(2));
}
`,
);

writeFileSync(
  join(dir, 'test', 'cart.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { subtotal } from '../src/cart.js';

test('小计计算正确', () => {
  assert.equal(subtotal([{ price: 100, qty: 2 }]), 180);
});

test('不得修改传入的数据（幂等）', () => {
  const items = [{ price: 100, qty: 1 }];
  subtotal(items);
  assert.equal(items[0].price, 100, '原价格不得被打折污染');
});

test('两次调用结果一致', () => {
  const items = [{ price: 50, qty: 3 }];
  const first = subtotal(items);
  const second = subtotal(items);
  assert.equal(first, second);
  assert.equal(first, 135);
});

test('空购物车', () => {
  assert.equal(subtotal([]), 0);
});
`,
);
