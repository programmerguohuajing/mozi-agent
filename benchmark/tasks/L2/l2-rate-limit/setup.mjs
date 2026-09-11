// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'rate-limit.js'),
  `// TODO: 实现内存限流器（见 task.md）
export class RateLimiter {}
`,
);
