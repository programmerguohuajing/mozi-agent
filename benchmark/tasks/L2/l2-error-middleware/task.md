---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'dbe0ad43-c392-4649-bbdf-3f9085f2067f'
  PropagateID: 'dbe0ad43-c392-4649-bbdf-3f9085f2067f'
  ReservedCode1: '6da2bcc4-6bed-44f3-927b-3fe621a3f78c'
  ReservedCode2: '6da2bcc4-6bed-44f3-927b-3fe621a3f78c'
---

# 统一错误处理中间件

`server.js` 里每个 handler 都在手写 try-catch 并拼错误响应，重复且格式不一。

请实现 `handlers/with-error-handling.js`：

- `withErrorHandling(handler)` 返回包装后的 handler：正常调用透传返回值；抛错时返回 `{ status: 500, body: { error: { code: 'INTERNAL', message } } }`
- 支持 handler 抛 `HttpError(status, code, message)`（请新增该错误类），包装后返回 `{ status, body: { error: { code, message } } }`
- `server.js` 全部 handler 改用包装（保持正常路径返回值不变）

> AI生成