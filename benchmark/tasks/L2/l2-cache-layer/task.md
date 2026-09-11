---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'e3725cb9-b29b-4030-9570-df949748e719'
  PropagateID: 'e3725cb9-b29b-4030-9570-df949748e719'
  ReservedCode1: '44c9673c-ce01-45cb-8779-6201d473e4bd'
  ReservedCode2: '44c9673c-ce01-45cb-8779-6201d473e4bd'
---

# 给查询层加内存缓存

`db/query.js` 的 `fetchUser(id)` 每次都穿透到模拟慢查询。请新增 `cache/cache.js` 实现通用 TTL 内存缓存，并接入 `fetchUser`：

- `cache.js`：`class TTLCache { get(key) / set(key, value, ttlMs) / clear() }`，过期条目读取时返回 `undefined` 并清理
- `fetchUser` 结果缓存 1 秒：同一 id 连续两次调用只打一次底层查询
- 1 秒后缓存过期，再次调用重新查询

> AI生成