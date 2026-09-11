---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '5c1faff8-b7c4-46ce-be27-01f4a0953f45'
  PropagateID: '5c1faff8-b7c4-46ce-be27-01f4a0953f45'
  ReservedCode1: '09d2754c-e6f2-4834-9286-693caad0b31a'
  ReservedCode2: '09d2754c-e6f2-4834-9286-693caad0b31a'
---

# 修复正则未转义导致的崩溃

`highlight.js` 的 `highlight(text, term)` 用 `new RegExp(term)` 把关键词包上 `<mark>`。但当 `term` 含正则特殊字符（如 `(`、`*`、`+`）时构造直接抛异常。

请修复：把 `term` 按字面量处理（转义特殊字符），并保持大小写敏感的原有行为。

> AI生成