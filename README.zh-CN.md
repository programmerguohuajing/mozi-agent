---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'f9e294aa-8518-44a1-be10-1dc3cecef86c'
  PropagateID: 'f9e294aa-8518-44a1-be10-1dc3cecef86c'
  ReservedCode1: 'bacc9e4a-9fad-4a73-8208-439ea3882c0c'
  ReservedCode2: 'bacc9e4a-9fad-4a73-8208-439ea3882c0c'
---

<div align="center">
  <img src="docs/logo/mozi-logo.png" width="200" alt="Mozi Logo" />
</div>

# 墨子 (Mozi)

[English](README.md) | **简体中文**

**一个常驻你本机的开源编码智能体。**

> 墨家，中国古代唯一的「工程师学派」——机关术造工具，名辩术讲逻辑，守城术筑安全。
> 墨子（Mozi）是这三件事的现代实现：工具系统 · Agent Loop · 四级沙箱。

## 墨子是什么？

墨子是一个 TypeScript 编码智能体（可对标 Codex CLI / Claude Code），但有一个本质区别：**引擎即产品。**

- **CLI + 桌面端 + 移动端** —— 三种外壳，一个引擎，一套事件协议
- **子智能体** —— 委派隔离上下文的任务（探索 / 通用 / 评审）
- **定时任务** —— cron 驱动的无人值守执行，git-worktree 产物隔离
- **多模型** —— OpenAI / Anthropic / DeepSeek / Qwen / Ollama 一等公民支持
- **完整 MCP 客户端** —— stdio + Streamable HTTP，Tools / Resources / Prompts / Sampling
- **本地优先** —— 引擎运行在你自己的机器上；移动端经端到端加密的自托管中继接入

## 当前状态

**M0 —— 项目初始化。** 完整设计见 `docs/`：

| 文档 | 内容 |
|------|------|
| `docs/仿Codex-Agent开发技术方案.md` | 技术方案：目标、架构、里程碑 M0–M5 |
| `docs/Mozi-详细设计文档.md` | 详细设计：18 个模块（M1–M18），可直接落地 |

## 快速开始（开发环境）

```bash
# 环境要求：Node >= 20，pnpm >= 9
pnpm install
pnpm build
pnpm test
```

## 仓库结构

```
packages/
  shared/        # DTO：事件、消息、错误码（零依赖）
  core/          # AgentEngine、ContextManager、SessionStore、子智能体、任务
  policy/        # 审批策略引擎 + 命令风险分析
  tools/         # 内置工具 + PatchEngine（apply_patch）
  providers/     # LLM 适配器 + ScriptedProvider（确定性测试）
  sandbox/       # 四级沙箱（L0–L3）
  mcp-client/    # 完整 MCP 客户端
  config/        # 分层配置
  protocol/      # 统一通道语义（进程内 / IPC / WSS）
  relay-server/  # 自托管 E2E 中继（零内容路由）
  tui/           # Ink 终端 UI
  desktop/       # Electron 桌面应用
apps/
  cli/           # `mozi` 命令行程序
  mobile/        # Expo / React Native 客户端
benchmark/       # 评测任务集（L1–L4）
docs/            # 设计文档
examples/        # 引擎嵌入示例
```

## 许可证

[MIT](./LICENSE)

> AI生成