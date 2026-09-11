export class RateLimiter {
  #max;
  #windowMs;
  #buckets = new Map();

  constructor({ max, windowMs }) {
    if (!Number.isInteger(max) || max < 1) throw new Error('max 需为正整数');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs 需为正数');
    this.#max = max;
    this.#windowMs = windowMs;
  }

  acquire(key) {
    const now = Date.now();
    let bucket = this.#buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.#windowMs };
      this.#buckets.set(key, bucket);
    }
    if (bucket.count >= this.#max) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, remaining: this.#max - bucket.count };
  }

  reset(key) {
    this.#buckets.delete(key);
  }
}
