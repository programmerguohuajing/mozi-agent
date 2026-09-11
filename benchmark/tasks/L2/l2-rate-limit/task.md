---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a46f624f-24e4-4428-a63f-d4db46fc5e95'
  PropagateID: 'a46f624f-24e4-4428-a63f-d4db46fc5e95'
  ReservedCode1: '0c6e52eb-5162-40ab-a600-3b2eee2c4620'
  ReservedCode2: '0c6e52eb-5162-40ab-a600-3b2eee2c4620'
---

# 实现内存限流器

请新建 `rate-limit.js` 实现 `RateLimiter`：

- 构造：`new RateLimiter({ max, windowMs })`
- `acquire(key)`：窗口内计数未满返回 `{ allowed: true, remaining }`；已满返回 `{ allowed: false, remaining: 0, retryAfterMs }`（提示距窗口重置还有多久）
- 不同 key 互不影响；窗口过期后计数自动重置
- 补充 `reset(key)`：清掉指定 key 的计数

> AI生成