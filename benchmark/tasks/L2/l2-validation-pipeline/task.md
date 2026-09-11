---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'e2a702af-8cfe-4d02-82fa-5813c5861a3c'
  PropagateID: 'e2a702af-8cfe-4d02-82fa-5813c5861a3c'
  ReservedCode1: '227a759f-7340-4c18-add8-3feee84c8ced'
  ReservedCode2: '227a759f-7340-4c18-add8-3feee84c8ced'
---

# 抽取请求校验管线

`api/createUser.js` 里手写的零散校验难以复用。请新建 `validate/` 模块统一校验：

- `validate/rules.js`：导出 `required()`、`string({ min, max })`、`email()`、`min(n)`（数值下限）等规则构造器
- `validate/index.js`：`validate(obj, schema)`，schema 形如 `{ name: [rules...], age: [rules...] }`；全部通过返回 `{ valid: true, errors: [] }`，否则 `{ valid: false, errors: [{ field, message }] }`
- `createUser.js` 改用该管线：name 必填且 2-20 字符、email 必填且合法、age 可选且 ≥ 0

> AI生成