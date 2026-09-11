---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd18022fd-865c-43c5-9e96-3145a32c51c6'
  PropagateID: 'd18022fd-865c-43c5-9e96-3145a32c51c6'
  ReservedCode1: 'af3e11a4-64e9-4d9f-8db8-a01f04749803'
  ReservedCode2: 'af3e11a4-64e9-4d9f-8db8-a01f04749803'
---

# 调试：购物车小计把原数据改坏了

`src/cart.js` 的 `subtotal(items)` 计算折扣小计时，把传入的商品数组也改了（价格被原地打折），调用方之后再读 `items` 会得到错误价格。

`test/cart.test.mjs` 已经全红。请找到原因并修复：`subtotal` 不得修改传入的数据（保持其返回值语义：打 9 折后的总价，四舍五入两位小数）。

要求：`test/` 下的测试**不许修改**，修复源码让全部测试通过。

> AI生成