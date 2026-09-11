---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '415bf28c-5882-4e33-b9f3-9f5a2993b930'
  PropagateID: '415bf28c-5882-4e33-b9f3-9f5a2993b930'
  ReservedCode1: '15eec9f0-5d4e-4f3b-9bd5-72a75a685e61'
  ReservedCode2: '15eec9f0-5d4e-4f3b-9bd5-72a75a685e61'
---

# 清理用户输入的首尾空白

`normalize.js` 的 `normalizeName(name)` 用于存储前规范化用户名，但没有去除首尾空白与内部连续空格，导致 `' alice '` 与 `'alice'` 被当成两个用户。

请修复：去除首尾空白，并把内部连续空白压缩为单个空格。空输入应返回空字符串。

> AI生成