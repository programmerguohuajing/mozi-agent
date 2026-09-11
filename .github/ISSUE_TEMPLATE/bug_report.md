---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd95e4b76-e528-4b8d-b5a9-18ac2b2e5f06'
  PropagateID: 'd95e4b76-e528-4b8d-b5a9-18ac2b2e5f06'
  ReservedCode1: 'b77a25d7-cdbc-497f-8b7d-fb2b3993f3ba'
  ReservedCode2: 'b77a25d7-cdbc-497f-8b7d-fb2b3993f3ba'
---

name: Bug 报告
about: 某个功能坏了 / 行为不符合预期
title: 'fix: '
labels: bug
body:
  - type: textarea
    id: what-happened
    attributes:
      label: 发生了什么？
      description: 清晰描述问题与预期行为的差异
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: 复现步骤
      placeholder: |
        1. 运行 `mozi ...`
        2. 输入 ...
        3. 看到 ...
    validations:
      required: true
  - type: textarea
    id: env
    attributes:
      label: 环境
      placeholder: OS / Node 版本 / mozi 版本 / 模型与 Provider
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: 相关日志或会话事件流
      description: `mozi exec --json` 的输出或 ~/.mozi/sessions 下的 JSONL 片段

> AI生成