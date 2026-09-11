---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '1f13b45a-d2e1-4104-876b-95545cfe2452'
  PropagateID: '1f13b45a-d2e1-4104-876b-95545cfe2452'
  ReservedCode1: '57b67f19-9f5d-4c58-9c03-b039cf3d6386'
  ReservedCode2: '57b67f19-9f5d-4c58-9c03-b039cf3d6386'
---

# custom-tool

给墨子引擎扩展一个自定义工具——mozi 的工具系统是开放的：**任何能力，一个对象**。

```bash
# 在仓库根目录
pnpm build                                  # 先构建 workspace 包
pnpm --filter @mozi/example-custom-tool start
```

一个工具 = 实现 `AgentTool` 契约的普通对象：

| 字段 | 说明 |
|------|------|
| `name` / `version` / `description` | 模型可见的标识与描述（description 写得越清楚，模型用得越准） |
| `parameters` | JSON Schema，引擎把工具清单发给模型自行决策调用 |
| `riskLevel` | `read` / `meta` 参与读并行调度；`write` / `exec` 强制串行，`exec` 还会走审批策略 |
| `execute(input, ctx)` | 执行体；`ctx.workspace`（工作区）、`ctx.signal`（中止信号）、`ctx.session.meta`（会话级状态） |

本例演示了与 `createEngine()` 不同的组装方式——直接 `new AgentEngine(deps)`，
适合需要完全控制工具注册表、策略引擎与上下文管理器的高级嵌入场景。

> AI生成