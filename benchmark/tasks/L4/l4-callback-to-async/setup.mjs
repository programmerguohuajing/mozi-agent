// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'fsx.js'),
  `import { readFile, writeFile, appendFile } from 'node:fs';

// TODO: 全部迁移为 async/await + node:fs/promises（见 task.md）
export function readText(file, cb) {
  readFile(file, 'utf8', (err, data) => {
    if (err) cb(err);
    else cb(null, data);
  });
}

export function writeText(file, content, cb) {
  writeFile(file, content, 'utf8', (err) => {
    if (err) cb(err);
    else cb(null);
  });
}

export function appendText(file, content, cb) {
  appendFile(file, content, 'utf8', (err) => {
    if (err) cb(err);
    else cb(null);
  });
}
`,
);
