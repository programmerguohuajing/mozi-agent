---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '273d2d0b-4af7-493b-83b2-e880db226524'
  PropagateID: '273d2d0b-4af7-493b-83b2-e880db226524'
  ReservedCode1: 'a207aa83-59d0-4a9e-91aa-1f595bc2fd70'
  ReservedCode2: 'a207aa83-59d0-4a9e-91aa-1f595bc2fd70'
---

# API 参考 · Tools（@mozi/tools）

## 内置工具集

`createBuiltinRegistry()` 返回注册了以下工具的 `ToolRegistry`：

| 工具 | riskLevel | 说明 |
|------|-----------|------|
| `read_file` | read | 行区间读取 / 行号前缀 / 二进制探测 |
| `write_file` | write | 幂等建父目录 + tmp-rename 原子写 |
| `edit_file` | exec | apply_patch 事务型编辑（快照 + 回滚） |
| `glob` | read | 自实现轻量 glob（`**` / `*` / `?` + gitignore 合并） |
| `grep` | read | 递归正则（文件:行号:内容，上限截断） |
| `shell` | exec | spawn 执行；有沙箱时经沙箱通道 |
| `todo_list` | meta | 会话级任务清单（list / update） |
| `task` | meta | 子智能体派发（并入读并行组，受并发槽控流） |

## ToolRegistry

| 成员 | 说明 |
|------|------|
| `register(...tools)` | 注册（重名抛错） |
| `unregister(name)` / `get(name)` / `has(name)` | 查询 |
| `names()` / `schemas()` | 模型可见清单 |
| `groupBySafety(calls)` | 读并行 / 写串行调度分组 |

## AgentTool 契约

```ts
interface AgentTool<TInput = Record<string, unknown>> {
  name: string;
  version: string;
  description: string;
  parameters: JSONSchema;
  riskLevel: RiskLevel;               // read | meta | write | exec
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
```

详细扩展指南见[工具扩展开发](../extending-tools)。

## 结果构造

- `ok(content, display?)`：成功结果（引擎回填 callId）
- `fail(content, errorKind?)`：失败结果
- `truncate(text, head = 200, tail = 50)`：大输出截断（保留首尾 + 中间省略标记）

## Workspace

| 成员 | 说明 |
|------|------|
| `resolve(path)` | 解析并约束在工作区内（穿越被拒） |
| `readFile` / `writeFile` / `deleteFile` | 基础文件操作（写为原子写） |
| `saveSnapshot` / `listSnapshots` / `undoLast` | 会话级编辑快照（`/undo` 后端） |

## PatchEngine（apply_patch）

`edit_file` 的底层三件套（也可单独用于构建自己的编辑工具）：

- `patch-parser.ts`：Update / Add / Delete 语法解析（hunk signature + additions）
- `patch-matcher.ts`：hunk 锚点匹配（尾随空白容忍 / 顺序推进 / 前缀回退 / 最近匹配诊断）
- `patch-applier.ts`：事务型应用（Phase1 全量只读匹配 → Phase2 快照+写入 → 失败整体回滚）

> AI生成