// 断言：node check.mjs <workspace>
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { sign, verify, handleWebhook } = await import(pathToFileURL(join(process.argv[2], 'webhook.js')));

const secret = 'whsec_topsecret';
const body = { event: 'order.paid', id: 42 };

const sig = sign(body, secret);
assert.match(sig, /^[0-9a-f]{64}$/, '签名为 64 位十六进制 HMAC-SHA256');
assert.equal(sign(body, secret), sig, '同输入签名稳定');
assert.notEqual(sign({ ...body, id: 43 }, secret), sig, '内容变化签名变化');

assert.equal(verify(body, sig, secret), true, '正确签名通过');
assert.equal(verify(body, sig, 'wrong-secret'), false, '错误密钥拒绝');
assert.equal(verify(body, sig.toUpperCase(), secret), true, '大写十六进制兼容');
assert.equal(verify(body, 'deadbeef', secret), false, '格式非法不抛错返回 false');
assert.equal(verify(body, 'z'.repeat(64), secret), false, '非十六进制拒绝');

const ok = handleWebhook(body, sig, secret);
assert.deepEqual(ok, { ok: true, event: 'order.paid' }, '验签通过返回事件');
const bad = handleWebhook(body, sig, 'wrong-secret');
assert.deepEqual(bad, { ok: false, reason: 'bad_signature' }, '验签失败结构化拒绝');

console.log('l2-webhook-sign: OK');
