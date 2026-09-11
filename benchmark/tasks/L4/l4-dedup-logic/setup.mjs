// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'handlers'), { recursive: true });

writeFileSync(
  join(dir, 'handlers', 'create-article.js'),
  `export function createArticle(body) {
  const errors = [];
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    errors.push({ field: 'title', message: 'title 不能为空' });
  }
  if (typeof body.content !== 'string' || body.content.trim() === '') {
    errors.push({ field: 'content', message: 'content 不能为空' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
`,
);

writeFileSync(
  join(dir, 'handlers', 'create-comment.js'),
  `export function createComment(body) {
  const errors = [];
  if (typeof body.author !== 'string' || body.author.trim() === '') {
    errors.push({ field: 'author', message: 'author 不能为空' });
  }
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    errors.push({ field: 'text', message: 'text 不能为空' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
`,
);

writeFileSync(
  join(dir, 'handlers', 'create-tag.js'),
  `export function createTag(body) {
  const errors = [];
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    errors.push({ field: 'name', message: 'name 不能为空' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
`,
);
