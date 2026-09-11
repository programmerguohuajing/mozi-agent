---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '23c14f9f-e9a1-4739-a312-b445218d7579'
  PropagateID: '23c14f9f-e9a1-4739-a312-b445218d7579'
  ReservedCode1: '569c898c-e399-44fa-9f5f-e6b329722f4a'
  ReservedCode2: '569c898c-e399-44fa-9f5f-e6b329722f4a'
---

# 给用户列表 API 加分页参数

当前 `api/users.js` 的 `listUsers()` 一次性返回全部用户，数据量增长后需要分页。

请实现：
- `listUsers({ page = 1, limit = 20 } = {})` 支持分页参数（page 从 1 开始，limit 上限 100，非法值回退默认）
- 返回结构改为 `{ data, page, limit, total }`
- 越界页返回空 `data`，`total` 仍为总数

> AI生成