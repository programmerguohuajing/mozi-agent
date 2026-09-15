// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

// 源码已是 Promise 风格
const src = readFileSync(join(dir, 'fsx.js'), 'utf8');
assert.ok(/node:fs\/promises/.test(src), '应改用 node:fs/promises');
assert.ok(!/cb\(/.test(src), '不得再有回调参数');

const { readText, writeText, appendText } = await import(pathToFileURL(join(dir, 'fsx.js')));

const tmp = mkdtempSync(join(tmpdir(), 'mozi-l4-'));
const file = join(tmp, 'a.txt');

// write → read
await writeText(file, 'hello');
assert.equal(await readText(file), 'hello', '写入后可读回');

// append 语义
await appendText(file, ' world');
assert.equal(await readText(file), 'hello world', '追加写');

// 覆盖写语义
await writeText(file, 'reset');
assert.equal(await readText(file), 'reset', '覆盖写');

// 失败路径：不存在的文件应 reject
await assert.rejects(() => readText(join(tmp, 'nope.txt')), '读不存在文件应 reject');

// 返回值是 Promise
const p = writeText(file, 'x');
assert.ok(p instanceof Promise, '返回 Promise');
await p;

console.log('l4-callback-to-async: OK');
