// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { highlight } = await import(pathToFileURL(join(process.argv[2], 'highlight.js')));

assert.equal(highlight('a(b)c', '('), 'a<mark>(</mark>b)c', '特殊字符不抛错且正确高亮');
assert.equal(highlight('2+2=4', '2+2'), '<mark>2+2</mark>=4', '+ 不会被当作量词');
assert.equal(highlight('hello world', 'world'), 'hello <mark>world</mark>', '正常词高亮');
assert.equal(highlight('hello', 'HELLO'), 'hello', '保持大小写敏感');
assert.equal(highlight('abc', 'x'), 'abc', '未命中原样返回');
assert.equal(highlight('abc', ''), 'abc', '空 term 原样返回');

console.log('l1-regex-escape: OK');
