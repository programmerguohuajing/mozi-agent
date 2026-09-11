---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'b8666973-21ef-4250-bc25-9b9a62879463'
  PropagateID: 'b8666973-21ef-4250-bc25-9b9a62879463'
  ReservedCode1: 'de3fe6cb-1e3f-441b-a20b-9d99e178d0f9'
  ReservedCode2: 'de3fe6cb-1e3f-441b-a20b-9d99e178d0f9'
---

# 重构：把「什么都装」的大文件拆成三个模块

`lib/everything.js` 把格式化、HTTP 模拟、存储三个不相关的领域全部塞在一个文件里（每个域都有对外使用者）。

请拆分为：
- `lib/format.js`：`formatDate`、`formatMoney`
- `lib/http.js`：`httpGet`、`httpPost`
- `lib/storage.js`：`save`、`load`

并保持 `lib/everything.js` 存在且**再导出全部原 API**（既有 import 不得破坏）。行为必须完全不变。

> AI生成