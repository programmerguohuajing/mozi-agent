---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '8a5bcbd6-54cb-4d2c-9780-f06f8dd0b4c9'
  PropagateID: '8a5bcbd6-54cb-4d2c-9780-f06f8dd0b4c9'
  ReservedCode1: '7d7aa6f7-45a4-4564-8511-5a357af03982'
  ReservedCode2: '7d7aa6f7-45a4-4564-8511-5a357af03982'
---

# 重构：回调风格改 async/await

`fsx.js` 用旧的回调风格（`cb(err, data)`）暴露文件工具。请全部迁移为返回 Promise 的 async API：

- `readText(file)` → Promise\<string\>
- `writeText(file, content)` → Promise\<void\>
- `appendText(file, content)` → Promise\<void\>

保持函数名与模块路径不变；删除回调参数；实现内部改用 `node:fs/promises`。行为语义（读 UTF-8 文本、覆盖写、追加写）不变。

> AI生成