// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const src = readFileSync(join(dir, 'pricing.js'), 'utf8');

for (const name of ['TAX_RATE', 'FREE_SHIPPING_THRESHOLD', 'BASE_SHIPPING_FEE']) {
  assert.ok(new RegExp(`\\b${name}\\b`).test(src), `应定义并使用常量 ${name}`);
}
assert.ok(!/\b0\.08\b/.test(src.replace(/TAX_RATE = 0\.08/, '')), '税率魔法数字应被常量取代');

const { calcPrice } = await import(pathToFileURL(join(dir, 'pricing.js')));
// 行为不变式（与原实现对拍）
const expect = (q, p) => {
  const subtotal = q * p;
  const shipping = q >= 3 ? 0 : 10;
  const tax = (subtotal + shipping) * 0.08;
  return Number((subtotal + shipping + tax).toFixed(2));
};
assert.equal(calcPrice(1, 100), expect(1, 100));
assert.equal(calcPrice(2, 25.5), expect(2, 25.5));
assert.equal(calcPrice(3, 10), expect(3, 10), '达到免运费门槛');
assert.equal(calcPrice(5, 0), expect(5, 0));

console.log('l1-constant-extract: OK');
