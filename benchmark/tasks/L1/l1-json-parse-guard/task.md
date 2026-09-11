---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd2e77c90-77ad-4f00-801f-3808721f0251'
  PropagateID: 'd2e77c90-77ad-4f00-801f-3808721f0251'
  ReservedCode1: '65641644-9e27-4dba-abe1-c30c1eb00da9'
  ReservedCode2: '65641644-9e27-4dba-abe1-c30c1eb00da9'
---

# 让 safeParse 真正安全

`json.js` 的 `safeParse(text)` 声称安全解析 JSON，遇到非法 JSON 应返回 `null` 而不是抛异常。但现在它直接调 `JSON.parse`，非法输入会炸。

请修复：解析成功返回解析值，失败返回 `null`（不要吞掉其他类型错误以外的异常语义，仅针对解析失败）。

> AI生成