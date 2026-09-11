---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '977087c6-e6ed-4912-a1e7-422d080ab733'
  PropagateID: '977087c6-e6ed-4912-a1e7-422d080ab733'
  ReservedCode1: '97681922-a6f9-4cf1-a286-6ebd51fb78a0'
  ReservedCode2: '97681922-a6f9-4cf1-a286-6ebd51fb78a0'
---

# 快速开始

## 安装

```bash
# 从源码运行（当前阶段推荐）
git clone https://github.com/programmerguohuajing/mozi-agent.git
cd mozi-agent
pnpm install && pnpm build

# CLI 入口
node apps/cli/dist/index.js --help
```

## 连接模型

墨子支持任意 OpenAI 兼容端点（DeepSeek / Qwen / GLM / Ollama / vLLM…），以及 Anthropic、Gemini 原生协议。
通过环境变量配置：

```bash
export MOZI_BASE_URL="https://api.deepseek.com/v1"
export MOZI_API_KEY="sk-..."
export MOZI_MODEL="deepseek-chat"    # 可选，默认 deepseek-chat

mozi "读取本目录 README 并统计字数"
```

未配置密钥时进入**离线演示模式**（ScriptedProvider 回放，零 API 成本，适合试用与 CI）。

## CLI 用法

```bash
# 交互 REPL
mozi

# 非交互单任务（NDJSON 事件流输出）
mozi exec --json "修复 utils/date.ts 的时区 bug"

# 指定会话（resume 续聊）
mozi exec --session my-session "继续"

# 审批模式
mozi exec --policy readonly "看看这个仓库"   # 只读，任何写操作被拒
mozi exec --policy full-auto "跑测试并修复"  # 全自动（Windows 自动降级为 ask）
mozi exec --yes "..."                        # 非交互时自动批准

# 会话管理
mozi sessions    # 列出本地会话
```

REPL 内置命令：`exit` 退出、`/undo` 撤销最近一次文件修改（基于会话级快照）。

## 引擎嵌入（差异能力）

墨子的引擎是独立 npm 包，这是它和「纯 CLI 工具」的本质区别：

```bash
npm install @mozi/core @mozi/providers
```

50 行完整示例见仓库 `examples/embed-minimal/`（工具扩展见 `examples/custom-tool/`），
详细指南见[引擎嵌入指南](./embedding)。

## 从这里出发

- [配置手册](./configuration) —— 环境变量、会话限制、策略三档
- [安全模型白皮书](./security) —— 沙箱四级、审批、注入防护红线
- [评测](/benchmark) —— 30 任务自建评测集与跑分

> AI生成