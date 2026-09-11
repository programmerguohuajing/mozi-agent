---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd169e599-9a53-4b50-8ec7-1e02e90a5fa6'
  PropagateID: 'd169e599-9a53-4b50-8ec7-1e02e90a5fa6'
  ReservedCode1: '5ab09c9c-0ad4-44a8-a9da-a837dcba94a9'
  ReservedCode2: '5ab09c9c-0ad4-44a8-a9da-a837dcba94a9'
---

# 工具扩展开发

墨子的工具系统是开放的：**任何能力，一个对象**。完整可运行示例见仓库 `examples/custom-tool/`。

## AgentTool 契约

```ts
import { ok, type AgentTool, type ToolContext } from '@mozi/tools';

const myTool: AgentTool<MyInput> = {
  name: 'my_tool',                    // 唯一名（模型可见）
  version: '1.0.0',
  description: '一句话讲清用途与适用场景', // 写得越准，模型用得越对
  parameters: {                       // JSON Schema
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  riskLevel: 'read',                  // read | meta | write | exec
  async execute(input, ctx) {
    return ok('结果文本（回填给模型）');
    // 失败：return fail('原因', 'errorKind')
  },
};
```

## riskLevel 决定调度与审批

| 级别 | 调度 | 审批 |
|------|------|------|
| `read` / `meta` | 与其他读操作**并行**执行 | 放行 |
| `write` | 强制**串行**（前序写完成才继续） | 按策略 |
| `exec` | 串行 | 默认走审批卡片（风险分析参与裁决） |

## ToolContext

```ts
interface ToolContext {
  workspace: Workspace;        // 工作区（resolve/readFile/writeFile —— 路径被约束在工作区内）
  signal: AbortSignal;         // 中止信号（用户中断 / 超时会触发，长任务必须响应）
  sessionId: string;
  session?: SessionStateView;  // 会话级可变状态（meta 字典，todo_list 等用它）
  sandbox?: SandboxRunner;     // 引擎注入的沙箱（shell 类工具经此执行）
  emit?: (e: AgentEvent) => void; // 旁路事件出口（如进度）
}
```

## 注册

```ts
// 方式一：在引擎工厂之外完全自定义（高级）
const tools = createBuiltinRegistry(); // 内置 read/write/edit/glob/grep/shell/todo/task
tools.register(myTool);

const engine = new AgentEngine({
  tools, /* providers, policy, context, sessions, workspace */
});

// 方式二：内置工具 + MCP server 工具自动聚合（createEngine 的 mcpServers 选项）
```

## 建议

- **description 即提示词**：说明何时该用、何时不该用，比参数校验更影响调用质量
- 返回文本对 token 敏感：大输出用 `truncate()`（@mozi/tools 导出）截断
- 长任务定期检查 `ctx.signal.aborted` 并尽快返回
- 结构化结果放 `display`（UI 渲染用），`content` 保持模型友好的纯文本

> AI生成