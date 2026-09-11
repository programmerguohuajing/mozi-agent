---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'dcff706e-d53d-4131-9011-13a530475b59'
  PropagateID: 'dcff706e-d53d-4131-9011-13a530475b59'
  ReservedCode1: '7a9d732c-90e4-4261-8e02-18246657b6b1'
  ReservedCode2: '7a9d732c-90e4-4261-8e02-18246657b6b1'
---

# 调试：加粗提取把中间内容吃掉了

`src/extract.js` 的 `extractBold(text)` 要提取所有 `<b>...</b>` 包裹的内容，但正则贪婪匹配把两个标签之间的普通文本也吞进第一组结果。

`test/extract.test.mjs` 已经全红。请修复正则与逻辑，正确提取每一对 `<b>` 的内容。

要求：`test/` 下的测试**不许修改**，修复源码让全部测试通过。

> AI生成