---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'b80e2b8c-2d60-4f6e-8815-9737e87887b6'
  PropagateID: 'b80e2b8c-2d60-4f6e-8815-9737e87887b6'
  ReservedCode1: '1322df6b-f791-43ac-8de4-608ad0b6aa4e'
  ReservedCode2: '1322df6b-f791-43ac-8de4-608ad0b6aa4e'
---

# Contributing to Mozi / 贡献指南

Thanks for your interest in contributing! 中文交流同样欢迎。

## Getting Started（30 分钟上手）

环境要求：Node >= 20，pnpm >= 9。

```bash
git clone https://github.com/programmerguohuajing/mozi-agent.git
cd mozi-agent
pnpm install
pnpm build        # 构建全部 workspace 包（依赖顺序由 turbo 编排）
pnpm test         # 全部单测/集成测试（ScriptedProvider 驱动，零 API 成本）
pnpm lint         # Biome 检查
pnpm typecheck    # tsc 类型检查
```

四条命令全绿，就说明你的环境就绪了。整个流程通常在 30 分钟内完成（首次 `pnpm install` 视网络情况）。

想快速感受引擎：`pnpm --filter @mozi/example-embed-minimal start`（50 行代码嵌入引擎的演示）。

## Repository Map

```
packages/
  shared/        # 跨层 DTO 契约（事件 / 消息 / 错误码）—— 改这里影响全仓，慎改
  core/          # AgentEngine 主循环 / 上下文 / 会话 / 子智能体
  policy/        # 审批策略引擎 + 命令风险分析
  tools/         # 内置工具 + PatchEngine（apply_patch）
  providers/     # LLM 适配器 + ScriptedProvider（确定性测试基建）
  sandbox/       # 四级沙箱（L0-L3）
  mcp-client/    # 完整 MCP 客户端
  config/ protocol/ relay-server/ tui/ desktop/
apps/
  cli/           # `mozi` 命令行
benchmark/       # 30 任务评测集（L1-L4）
examples/        # 引擎嵌入示例
docs/            # 设计文档（架构变更前必读）
website/         # 文档站（VitePress）
```

改 `packages/core` 之前，请先读 `docs/Mozi-详细设计文档.md` 对应模块章节。

## Pull Requests

- Trunk-based：短生命周期分支，squash-merge 到 `master`
- **新模块必须同 PR 附带测试**（CI 强制；引擎行为测试用 ScriptedProvider 写成确定性用例，不花 API 费）
- 保持 PR 小而聚焦；大改拆系列 PR
- 引擎行为 / 提示词变更：跑 `pnpm --filter @mozi/benchmark smoke` 确认评测集无回退
- 代码风格由 Biome 托管（`pnpm lint:fix`），不要手工对抗格式化
- 提交信息用中文 conventional commits：`feat(core): 子智能体支持自定义模板`

## 版本与发布

- **不要在 PR 里改版本号**——发布由维护者通过 [changesets](https://github.com/changesets/changesets) 管理：
  行为变更的 PR 在 `.changeset/` 下附一个 changeset 文件（`pnpm changeset` 生成）
- merge 后 Version PR 统一升版 + 生成 CHANGELOG，打 tag 触发发布流水线

## Security

安全漏洞**不要开公开 Issue**，见 [SECURITY.md](./SECURITY.md)。

## License

贡献即表示你同意以 [MIT](./LICENSE) 许可发布你的贡献。

> AI生成