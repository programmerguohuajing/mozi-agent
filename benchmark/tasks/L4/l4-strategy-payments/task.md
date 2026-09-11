---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '673ff8ae-9c8e-4f2b-b825-0a94726911e0'
  PropagateID: '673ff8ae-9c8e-4f2b-b825-0a94726911e0'
  ReservedCode1: '55bdb1b2-1c72-42e8-b5d0-f6e61ffd5420'
  ReservedCode2: '55bdb1b2-1c72-42e8-b5d0-f6e61ffd5420'
---

# 重构：支付方式 if-else 链改表驱动

`payments.js` 用 if-else 链分派支付方式，新增一种就要改函数体。请重构为表驱动（策略注册表）：

- 每种支付方式一个处理函数，注册进 `handlers` 表（key 为 `method`）
- `processPayment({ method, amount })` 查表分派；未注册的方式仍返回 `{ ok: false, reason: 'unsupported_method' }`
- 行为完全不变（含手续费计算、上下限校验）

> AI生成