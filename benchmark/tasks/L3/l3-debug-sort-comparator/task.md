---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '435a95bf-928e-4b3a-b196-d1bfbae7e374'
  PropagateID: '435a95bf-928e-4b3a-b196-d1bfbae7e374'
  ReservedCode1: 'e2e2cbe8-6d8c-4905-9523-c28af3a5c72a'
  ReservedCode2: 'e2e2cbe8-6d8c-4905-9523-c28af3a5c72a'
---

# 调试：优先级排序结果不稳定

`src/sort.js` 的 `byPriority(items)` 按 `priority` 从高到低排序，但比较器写成了返回布尔值而不是数字，排序结果错乱。

`test/sort.test.mjs` 已经全红。请修复比较器，使排序正确且同优先级保持稳定（按原顺序）。

要求：`test/` 下的测试**不许修改**，修复源码让全部测试通过。

> AI生成