---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '71fe572c-159a-47a7-9f2a-79495aba28e4'
  PropagateID: '71fe572c-159a-47a7-9f2a-79495aba28e4'
  ReservedCode1: '5169089d-c2c1-4423-b7f7-a78c99f8f548'
  ReservedCode2: '5169089d-c2c1-4423-b7f7-a78c99f8f548'
---

# 重命名导出：getUserData → fetchUserProfile

`lib/data.js` 导出的 `getUserData(id)` 命名与语义不符（它只做读取），需要全仓统一重命名为 `fetchUserProfile(id)`。

请完成重命名：
- `lib/data.js` 中导出名改为 `fetchUserProfile`
- 同步更新 `app.js` 中的 import 与所有调用处
- 旧名 `getUserData` 不得再被导出或引用
- 函数行为保持不变

> AI生成