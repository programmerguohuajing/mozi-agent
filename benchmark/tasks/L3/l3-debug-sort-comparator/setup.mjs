// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

writeFileSync(
  join(dir, 'src', 'sort.js'),
  `/**
 * 按 priority 从高到低排序；同优先级保持原有相对顺序。
 */
export function byPriority(items) {
  // BUG: 比较器返回布尔值而非数字，违反 Array#sort 契约
  return items.slice().sort((a, b) => a.priority > b.priority);
}
`,
);

writeFileSync(
  join(dir, 'test', 'sort.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { byPriority } from '../src/sort.js';

test('高优先级在前', () => {
  const out = byPriority([
    { name: 'low', priority: 1 },
    { name: 'high', priority: 3 },
    { name: 'mid', priority: 2 },
  ]);
  assert.deepEqual(out.map((x) => x.name), ['high', 'mid', 'low']);
});

test('同优先级保持稳定顺序', () => {
  const out = byPriority([
    { name: 'a', priority: 2 },
    { name: 'b', priority: 1 },
    { name: 'c', priority: 2 },
    { name: 'd', priority: 1 },
    { name: 'e', priority: 2 },
  ]);
  assert.deepEqual(out.map((x) => x.name), ['a', 'c', 'e', 'b', 'd']);
});

test('不修改原数组', () => {
  const input = [{ name: 'x', priority: 1 }, { name: 'y', priority: 9 }];
  byPriority(input);
  assert.equal(input[0].name, 'x', '原数组顺序不变');
});

test('空数组与单元素', () => {
  assert.deepEqual(byPriority([]), []);
  assert.deepEqual(byPriority([{ name: 'solo', priority: 1 }]), [{ name: 'solo', priority: 1 }]);
});
`,
);
