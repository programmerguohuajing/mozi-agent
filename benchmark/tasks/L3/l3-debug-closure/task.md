---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '616114c8-c100-41c0-a858-e4d936f2314d'
  PropagateID: '616114c8-c100-41c0-a858-e4d936f2314d'
  ReservedCode1: 'd6605aac-99a1-4b31-98fb-bcffc067b46e'
  ReservedCode2: 'd6605aac-99a1-4b31-98fb-bcffc067b46e'
---

# 调试：按钮回调全部返回同一个值

`src/buttons.js` 为 3 个按钮注册点击回调，但每个回调拿到的索引都错了（全部是 3）。

`test/buttons.test.mjs` 已经全红。请找到原因并修复，使每个回调返回自己的编号（0、1、2）。

要求：`test/` 下的测试**不许修改**，修复源码让全部测试通过。

> AI生成