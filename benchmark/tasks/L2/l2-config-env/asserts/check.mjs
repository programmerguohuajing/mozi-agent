// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { loadConfig } = await import(pathToFileURL(join(process.argv[2], 'config.js')));

const base = loadConfig({});
assert.deepEqual(base, { port: 3000, host: 'localhost', debug: false }, '无环境变量时用默认值');

assert.deepEqual(
  loadConfig({ PORT: '8080', HOST: '0.0.0.0', DEBUG: 'true' }),
  { port: 8080, host: '0.0.0.0', debug: true },
  '环境变量覆盖',
);
assert.equal(loadConfig({ PORT: '9000' }).port, 9000, 'PORT 转数字');
assert.equal(loadConfig({ DEBUG: '1' }).debug, true, 'DEBUG=1 为真');
assert.equal(loadConfig({ DEBUG: 'TRUE' }).debug, true, 'DEBUG 不区分大小写');
assert.equal(loadConfig({ DEBUG: 'yes' }).debug, false, '其他值视为假');
assert.equal(loadConfig({ PORT: '' }).port, 3000, '空串 PORT 用默认');

console.log('l2-config-env: OK');
