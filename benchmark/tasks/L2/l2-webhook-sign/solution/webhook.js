import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(body, secret) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function verify(body, signature, secret) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = sign(body, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handleWebhook(body, signature, secret) {
  if (!verify(body, signature, secret)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, event: body.event };
}
