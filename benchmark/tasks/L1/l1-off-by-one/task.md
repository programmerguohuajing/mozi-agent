---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '78798324-baa0-4817-b9e8-8446f3b51854'
  PropagateID: '78798324-baa0-4817-b9e8-8446f3b51854'
  ReservedCode1: '089712d4-c0e3-490f-b1e8-dd258f23561a'
  ReservedCode2: '089712d4-c0e3-490f-b1e8-dd258f23561a'
---

# 修复分页的差一错误（off-by-one）

`paginate.js` 的 `paginate(list, page, size)` 每页总是比预期少返回一个元素（最后一项被吞掉）。

例如 5 个元素、`size=2` 时第 1 页应返回 2 项，但现在只返回 1 项。

请修复 slicing 逻辑，使每页恰好返回 `size` 个元素（不足时返回剩余全部），并让 `pageCount` 正确。

> AI生成