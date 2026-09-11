// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];

const { t } = await import(pathToFileURL(join(dir, 'i18n.js')));

assert.equal(t('greeting', 'zh', { name: 'alice' }), '你好, alice', '中文 + 插值');
assert.equal(t('greeting', 'en', { name: 'alice' }), 'Hello, alice', '英文 + 插值');
assert.equal(t('farewell', 'en'), 'Goodbye', '无参数文案');
assert.equal(t('farewell'), '再见', '默认语言为中文');
assert.equal(t('nonexistent', 'en'), 'nonexistent', '英文缺 key 回退中文仍缺则返回 key');
assert.equal(t('nonexistent', 'zh'), 'nonexistent', '中文缺 key 返回 key 本身');

const { greeting, farewell } = await import(pathToFileURL(join(dir, 'messages.js')));
assert.equal(greeting('bob'), '你好, bob', 'greeting 保持可用');
assert.equal(greeting('bob', 'en'), 'Hello, bob');
assert.equal(farewell('en'), 'Goodbye');

console.log('l2-i18n-baseline: OK');
