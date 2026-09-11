// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { formatDate } = await import(pathToFileURL(join(process.argv[2], 'utils/date.js')));

const d = new Date(2026, 0, 15, 23, 30);
assert.equal(formatDate(d), '2026-01-15 23:30', 'formatDate 应按本地时间显示');

const d2 = new Date(2026, 2, 5, 4, 7);
assert.equal(formatDate(d2), '2026-03-05 04:07', '个位数字段需补零');

assert.equal(formatDate('2026-06-01T10:20:00'), '2026-06-01 10:20', '接受字符串输入');

console.log('l1-fix-date-timezone: OK');
