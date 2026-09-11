---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '7e72a8db-f078-4a15-ac4b-ab6754f063f6'
  PropagateID: '7e72a8db-f078-4a15-ac4b-ab6754f063f6'
  ReservedCode1: 'c665528d-da0f-428b-aaf5-851fd65d5bea'
  ReservedCode2: 'c665528d-da0f-428b-aaf5-851fd65d5bea'
---

# 给 Webhook 加 HMAC 签名校验

`webhook.js` 目前直接信任请求体，任何人都能伪造回调。请用 Node 内置 `crypto` 实现签名校验：

- `sign(body, secret)`：`HMAC-SHA256`，输出十六进制摘要
- `verify(body, signature, secret)`：签名匹配返回 `true`；不匹配或签名格式非法返回 `false`（不抛错）
- `handleWebhook(body, signature, secret)`：先验签，失败返回 `{ ok: false, reason: 'bad_signature' }`；成功返回 `{ ok: true, event: body.event }`

> AI生成