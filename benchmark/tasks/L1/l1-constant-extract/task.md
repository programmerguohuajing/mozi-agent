---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4387d2df-ad65-4ad9-8a1c-0e49b3033ebd'
  PropagateID: '4387d2df-ad65-4ad9-8a1c-0e49b3033ebd'
  ReservedCode1: '61166667-2210-4e5b-a1f2-d77d4744be16'
  ReservedCode2: '61166667-2210-4e5b-a1f2-d77d4744be16'
---

# 提取魔法数字为命名常量

`pricing.js` 的 `calcPrice(quantity, unitPrice)` 里散落着魔法数字：`0.08` 是税率，`3` 是免运费门槛（单位：件），`10` 是基础运费。

请把这三个数字提取为模块顶部的命名常量 `TAX_RATE`、`FREE_SHIPPING_THRESHOLD`、`BASE_SHIPPING_FEE` 并在函数中使用，**行为必须完全不变**。

> AI生成