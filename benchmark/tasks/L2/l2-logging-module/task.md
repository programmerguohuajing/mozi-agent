---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '1c667753-1227-4041-865e-201f3f505912'
  PropagateID: '1c667753-1227-4041-865e-201f3f505912'
  ReservedCode1: 'ce97d59e-f225-4f17-8b38-8895425858ef'
  ReservedCode2: 'ce97d59e-f225-4f17-8b38-8895425858ef'
---

# 用统一日志模块替换散落的 console

`service-a.js` 与 `service-b.js` 里散落着 `console.log/error`，无法统一控制级别与格式。

请新建 `logger.js` 并完成替换：

- `logger.js`：`createLogger(prefix)` 返回带 `debug/info/error` 三个方法的 logger；输出格式 `[LEVEL][prefix] message`
- 支持 `setLevel(level)`：低于设定级别的方法不再输出（debug < info < error）
- 两个 service 全部改用 logger，源码中不得再直接调用 `console.*`
- service 的对外行为（导出的函数返回值）不变

> AI生成