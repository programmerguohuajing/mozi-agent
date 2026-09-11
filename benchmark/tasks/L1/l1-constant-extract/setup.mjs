// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'pricing.js'),
  `/**
 * 计算订单价格：小计 → 运费 → 税。
 */
export function calcPrice(quantity, unitPrice) {
  const subtotal = quantity * unitPrice;
  // BUG(可读性): 魔法数字 0.08(税率) / 3(免运费门槛) / 10(基础运费) 散落函数体
  const shipping = quantity >= 3 ? 0 : 10;
  const tax = (subtotal + shipping) * 0.08;
  return Number((subtotal + shipping + tax).toFixed(2));
}
`,
);
