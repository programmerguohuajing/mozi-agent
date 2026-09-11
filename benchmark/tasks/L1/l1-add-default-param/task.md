---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '9e8642fb-1e0b-4231-9d9c-1037dfdaecf9'
  PropagateID: '9e8642fb-1e0b-4231-9d9c-1037dfdaecf9'
  ReservedCode1: '2c1bc4c5-edd7-48b7-84f1-ed2f8b121d7c'
  ReservedCode2: '2c1bc4c5-edd7-48b7-84f1-ed2f8b121d7c'
---

# 为 toRect 补默认参数

`rect.js` 的 `toRect(width, height)` 要求调用方总是传全两个参数，否则得到 `NaN` 尺寸。

请给两个参数加默认值：`width` 默认 `100`，`height` 默认 `50`。显式传入 `0` 时必须保持 `0`（不能被默认值覆盖）。

> AI生成