---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '02dc5cac-1520-4b5b-a30e-1896e75c6027'
  PropagateID: '02dc5cac-1520-4b5b-a30e-1896e75c6027'
  ReservedCode1: '367319e5-b091-4919-a407-f16af1ffbc79'
  ReservedCode2: '367319e5-b091-4919-a407-f16af1ffbc79'
---

# 支持环境变量覆盖配置

`config.js` 目前硬编码 `port: 3000, host: 'localhost', debug: false`，部署时无法不改代码切换环境。

请实现 `loadConfig()`：
- 以现有默认值为基线
- `PORT`、`HOST` 环境变量存在时覆盖（PORT 转数字）
- `DEBUG` 接受 `true`/`1`（不区分大小写）为真，其余为假
- 返回的对象不得受后续环境变量修改影响（每次调用读取当下值）

> AI生成