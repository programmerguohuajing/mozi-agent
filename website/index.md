---
hero:
  name: 墨子
  text: Mozi
  tagline: 常驻你本机的开源编码智能体 —— 引擎即产品
  image:
    src: /logo.png
    alt: Mozi Logo
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/programmerguohuajing/mozi-agent

features:
  - icon: 🧩
    title: 引擎可嵌入
    details: '@mozi/core 是独立 npm 包，零 UI 依赖。50 行代码把 Agent 引擎装进你自己的程序。'
  - icon: 🔀
    title: 多模型一等公民
    details: OpenAI / Anthropic / Gemini / DeepSeek / Qwen / GLM / Ollama —— 任意 OpenAI 兼容端点 + 能力协商。
  - icon: 🛡️
    title: 四级沙箱
    details: L0 直执行 → L1 进程组超时 → L2 OS 级（Seatbelt/Landlock）→ L3 Docker 隔离，优雅降级。
  - icon: 🔌
    title: 完整 MCP 客户端
    details: stdio + Streamable HTTP（含 OAuth 2.1）；Tools / Resources / Prompts / Sampling / Elicitation。
  - icon: 🤖
    title: 子智能体编排
    details: 隔离上下文的任务委派（explore / general / reviewer），权限单调收紧，审批冒泡。
  - icon: 📜
    title: 开放事件协议
    details: 全部行为以 AgentEvent 流式产出并 JSONL 落盘 —— 可回放、可 fork、可审计。
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a3ed2f90-abda-4b95-8b78-b88edb9470a6'
  PropagateID: 'a3ed2f90-abda-4b95-8b78-b88edb9470a6'
  ReservedCode1: 'b1804e61-8bbc-49c0-8806-6524b79ba1c4'
  ReservedCode2: 'b1804e61-8bbc-49c0-8806-6524b79ba1c4'
---

## 为什么是墨子？

> 墨家，中国古代唯一的「工程师学派」——机关术造工具，名辩术讲逻辑，守城术筑安全。
> Mozi 是这三件事的现代实现：**工具系统 · Agent Loop · 四级沙箱**。

与 Codex CLI / Claude Code 最大的差异：**引擎是独立产品**。CLI 只是引擎的一层壳，
你可以在自己的 Node.js 程序里嵌入完整的 Agent 能力（工具、策略、沙箱、子智能体、MCP）。

```ts
import { createEngine } from '@mozi/core';

const engine = createEngine({ /* sessionDir, workspaceRoot, providers */ });
for await (const event of engine.run({ sessionId: 's1', text: '修复测试' })) {
  // 事件流式消费：assistant 输出 / 工具执行 / 审批 / 用量
}
```

## 项目状态

M0–M5 + M4.5（定时任务）+ M4.75（移动端与远程）+ M4.9（学习扩展：提示词/记忆/多模态/Hooks）+ 内置浏览器/Git 工具均已交付。
完整路线图见仓库 `docs/`。

> AI生成