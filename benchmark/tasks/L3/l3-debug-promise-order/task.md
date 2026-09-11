---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '92c55049-589c-411b-a875-62d3d8fcab2f'
  PropagateID: '92c55049-589c-411b-a875-62d3d8fcab2f'
  ReservedCode1: 'ecc9b518-99fe-4ed4-b48e-a1cf99d51463'
  ReservedCode2: 'ecc9b518-99fe-4ed4-b48e-a1cf99d51463'
---

# 调试：异步任务的结果顺序错乱

`src/pipeline.js` 的 `runPipeline(tasks)` 应按输入顺序返回每个任务的执行结果，但用了 `forEach` 并发派发异步任务，结果顺序与输入对不上。

`test/pipeline.test.mjs` 已经全红。请修复，使结果严格按输入顺序排列（仍然并发执行，不要退化成串行）。

要求：`test/` 下的测试**不许修改**，修复源码让全部测试通过。

> AI生成