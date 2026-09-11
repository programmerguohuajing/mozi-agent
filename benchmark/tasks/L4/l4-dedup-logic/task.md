---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd07226f1-7d7e-43a6-8028-cc2568613de0'
  PropagateID: 'd07226f1-7d7e-43a6-8028-cc2568613de0'
  ReservedCode1: 'ba09ec55-c3de-4113-8521-3cff89e153f8'
  ReservedCode2: 'ba09ec55-c3de-4113-8521-3cff89e153f8'
---

# 重构：合并三个 handler 的重复校验逻辑

`handlers/` 下三个 handler 各自复制了一份几乎相同的「字段校验 + 错误包装」代码。

请去重：
- 新建 `handlers/validate-request.js`：导出 `validateRequest(body, schema)`，统一返回 `{ ok: true }` 或 `{ ok: false, errors: [{ field, message }] }`（schema 形如 `{ title: (v) => string | null, ... }`，返回错误消息或 null）
- 三个 handler 的公共部分（「必填非空字符串」规则）抽为可复用规则构造器 `nonEmptyString(message)`
- 各 handler 的对外行为（返回结构）必须完全不变

> AI生成