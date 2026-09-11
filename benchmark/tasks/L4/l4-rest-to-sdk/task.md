---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '73a70f57-3ab5-4f5f-9817-1c3a85293efb'
  PropagateID: '73a70f57-3ab5-4f5f-9817-1c3a85293efb'
  ReservedCode1: '62892713-7cb5-4e89-a7ff-22ff445ed2d1'
  ReservedCode2: '62892713-7cb5-4e89-a7ff-22ff445ed2d1'
---

# 重构：把 REST 客户端迁移到新 SDK（保持行为不变）

仓库提供了一个新的 `sdk/index.js`（`ResourceClient` 基类：`get/post/put/del` 封装了 URL 拼接与公共 headers）。`api/client.js` 仍用手写 fetch 拼 URL，请完成迁移：

- `api/client.js` 改用 `ResourceClient` 实现原有四个方法：`getUser(id)`、`listUsers()`、`createOrder(payload)`、`updateOrder(id, payload)`
- **行为必须完全不变**：相同的最终 URL、HTTP 方法、headers（`Authorization: Bearer <token>`）、请求体
- SDK 的 `ResourceClient` 构造为 `new ResourceClient({ baseUrl, token, resource })`（resource 如 `'users'`）

> AI生成