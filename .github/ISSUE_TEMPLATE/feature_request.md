---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'ecdba549-b447-4b9f-b7c1-d79cbe28d64e'
  PropagateID: 'ecdba549-b447-4b9f-b7c1-d79cbe28d64e'
  ReservedCode1: 'f72f43b4-bd1f-4283-ac81-7fa6dc2db536'
  ReservedCode2: 'f72f43b4-bd1f-4283-ac81-7fa6dc2db536'
---

name: 功能建议
about: 建议一个新能力或改进
title: 'feat: '
labels: enhancement
body:
  - type: textarea
    id: problem
    attributes:
      label: 你想解决什么问题？
      description: 描述你遇到的场景/痛点（而不是解决方案本身）
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: 期望的方案
      description: 你希望它如何工作？
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: 考虑过的替代方案
  - type: checkboxes
    id: scope
    attributes:
      label: 影响面
      options:
        - label: 涉及引擎行为（packages/core）
        - label: 涉及工具系统（packages/tools）
        - label: 涉及 CLI（apps/cli）
        - label: 仅文档 / 示例

> AI生成