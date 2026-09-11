// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 公共模块存在
assert.ok(existsSync(join(dir, 'handlers', 'validate-request.js')), 'validate-request.js 应存在');

// 各 handler 不再各自内联完整校验
for (const f of ['create-article.js', 'create-comment.js', 'create-tag.js']) {
  const src = readFileSync(join(dir, 'handlers', f), 'utf8');
  assert.ok(src.includes('validateRequest'), `${f} 应使用公共校验`);
  assert.ok(!/errors\.push/.test(src), `${f} 不应再内联拼错误数组`);
}

const { createArticle } = await import(pathToFileURL(join(dir, 'handlers', 'create-article.js')));
const { createComment } = await import(pathToFileURL(join(dir, 'handlers', 'create-comment.js')));
const { createTag } = await import(pathToFileURL(join(dir, 'handlers', 'create-tag.js')));

// 行为等价（与原实现逐字段对拍）
assert.deepEqual(createArticle({ title: 't', content: 'c' }), { ok: true });
assert.deepEqual(createArticle({}), {
  ok: false,
  errors: [
    { field: 'title', message: 'title 不能为空' },
    { field: 'content', message: 'content 不能为空' },
  ],
});
assert.deepEqual(createArticle({ title: 't', content: '  ' }), {
  ok: false,
  errors: [{ field: 'content', message: 'content 不能为空' }],
});

assert.deepEqual(createComment({ author: 'a', text: 'x' }), { ok: true });
assert.deepEqual(createComment({ author: 'a' }), {
  ok: false,
  errors: [{ field: 'text', message: 'text 不能为空' }],
});

assert.deepEqual(createTag({ name: 'n' }), { ok: true });
assert.deepEqual(createTag({}), {
  ok: false,
  errors: [{ field: 'name', message: 'name 不能为空' }],
});

console.log('l4-dedup-logic: OK');
