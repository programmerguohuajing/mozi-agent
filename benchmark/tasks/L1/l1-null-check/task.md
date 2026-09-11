---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6cc6bc42-5274-4187-b845-e856155a04ea'
  PropagateID: '6cc6bc42-5274-4187-b845-e856155a04ea'
  ReservedCode1: 'fbd36dc1-5592-407c-92ce-38dc6f098170'
  ReservedCode2: 'fbd36dc1-5592-407c-92ce-38dc6f098170'
---

# 补上空值防护

`address.js` 的 `getCity(user)` 直接链式取值 `user.address.city`，当 `user` 为 `null` 或 `address` 缺失时抛 `TypeError`。

请修复：任一层缺失时返回 `undefined` 而不是抛错；正常路径行为不变。

> AI生成