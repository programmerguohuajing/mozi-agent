// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'paginate.js'),
  `/**
 * 分页：page 从 1 开始。
 * 返回 { data, page, size, total, pageCount }
 */
export function paginate(list, page = 1, size = 10) {
  // BUG: 结束索引少了 1，导致每页吞掉最后一项
  const start = (page - 1) * size;
  const end = start + size - 1;
  const data = list.slice(start, end);
  return {
    data,
    page,
    size,
    total: list.length,
    pageCount: Math.ceil(list.length / size),
  };
}
`,
);
