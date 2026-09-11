// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

writeFileSync(
  join(dir, 'src', 'pipeline.js'),
  `/**
 * 并发执行任务，结果按输入顺序返回。
 */
export async function runPipeline(tasks) {
  const results = [];
  // BUG: forEach 并发派发，完成顺序不定，结果数组顺序与输入不对应
  tasks.forEach(async (task) => {
    const value = await task();
    results.push(value);
  });
  return results;
}
`,
);

writeFileSync(
  join(dir, 'test', 'pipeline.test.mjs'),
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/pipeline.js';

const delay = (ms, value) => () => new Promise((r) => setTimeout(() => r(value), ms));

test('结果按输入顺序排列（乱序完成）', async () => {
  const out = await runPipeline([delay(30, 'a'), delay(10, 'b'), delay(20, 'c')]);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('保持并发（总耗时接近最慢任务而非求和）', async () => {
  const started = Date.now();
  await runPipeline([delay(40, 1), delay(40, 2), delay(40, 3)]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, \`总耗时 \${elapsed}ms，不应串行（应 < 100ms）\`);
});

test('空任务列表', async () => {
  assert.deepEqual(await runPipeline([]), []);
});
`,
);
