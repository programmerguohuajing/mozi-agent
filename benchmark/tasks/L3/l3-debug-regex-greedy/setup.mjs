// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

writeFileSync(
  join(dir, 'src', 'extract.js'),
  `/**
 * 提取 text 中所有 <b>...</b> 的内容（按出现顺序）。
 */
export function extractBold(text) {
  // BUG: 贪婪量词 .* 跨越多个标签
  const matches = text.match(/<b>(.*)<\\/b>/g) ?? [];
  return matches.map((m) => m.replace(/<\/?b>/g, ''));
}
`,
);

writeFileSync(
  join(dir, 'test', 'extract.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBold } from '../src/extract.js';

test('多组加粗各自独立提取', () => {
  assert.deepEqual(extractBold('<b>a</b> x <b>b</b>'), ['a', 'b']);
});

test('单组', () => {
  assert.deepEqual(extractBold('hello <b>world</b>!'), ['world']);
});

test('无加粗', () => {
  assert.deepEqual(extractBold('plain text'), []);
});

test('加粗内容含空格与符号', () => {
  assert.deepEqual(extractBold('<b>hello world!</b>'), ['hello world!']);
});
`,
);
