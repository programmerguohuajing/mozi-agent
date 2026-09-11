// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'lib'), { recursive: true });

writeFileSync(
  join(dir, 'lib', 'data.js'),
  `const profiles = { 1: { id: 1, name: 'alice' }, 2: { id: 2, name: 'bob' } };

export function getUserData(id) {
  return profiles[id] ?? null;
}
`,
);

writeFileSync(
  join(dir, 'app.js'),
  `import { getUserData } from './lib/data.js';

export function greet(id) {
  const p = getUserData(id);
  return p ? \`hello, \${p.name}\` : 'hello, stranger';
}

export function label(id) {
  const p = getUserData(id);
  return p ? \`user#\${p.id}\` : 'user#?';
}
`,
);
