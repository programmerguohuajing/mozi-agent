// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

writeFileSync(
  join(dir, 'src', 'buttons.js'),
  `/**
 * 为 n 个按钮生成点击回调；回调返回按钮编号。
 */
export function buildHandlers(n) {
  const handlers = [];
  // BUG: var 声明的循环变量被闭包共享
  for (var i = 0; i < n; i++) {
    handlers.push(() => i);
  }
  return handlers;
}
`,
);

writeFileSync(
  join(dir, 'test', 'buttons.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from '../src/buttons.js';

test('每个回调返回自己的编号', () => {
  const handlers = buildHandlers(3);
  assert.equal(handlers[0](), 0);
  assert.equal(handlers[1](), 1);
  assert.equal(handlers[2](), 2);
});

test('单个按钮', () => {
  const handlers = buildHandlers(1);
  assert.equal(handlers[0](), 0);
});

test('零个按钮', () => {
  assert.deepEqual(buildHandlers(0), []);
});
`,
);
