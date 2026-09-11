// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'messages.js'),
  `// TODO: 改造为基于 i18n 的 t() 实现（见 task.md）
export function greeting(name) {
  return '你好, ' + name;
}

export function farewell() {
  return '再见';
}
`,
);
