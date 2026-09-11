---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'eb8563ba-9aa0-413c-854b-a08769b3c836'
  PropagateID: 'eb8563ba-9aa0-413c-854b-a08769b3c836'
  ReservedCode1: '8ef9c978-bd83-44fd-a5e3-88c7299e7daf'
  ReservedCode2: '8ef9c978-bd83-44fd-a5e3-88c7299e7daf'
---

# 补上丢失的 await

`profile.js` 的 `loadProfile(userId)` 想返回用户资料对象，但内部调用异步的 `fetchUser` 时漏了 `await`，导致返回的是一个未解析的 Promise，上层访问 `.name` 得到 `undefined`。

请修复异步逻辑，让 `loadProfile` 正确返回用户资料对象（保持导出名与参数不变）。

> AI生成