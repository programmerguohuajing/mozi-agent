---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '71c85650-c8e4-4197-8066-37201ec0f1af'
  PropagateID: '71c85650-c8e4-4197-8066-37201ec0f1af'
  ReservedCode1: '9a2b53ba-df46-49f1-ad49-dd4637c752cd'
  ReservedCode2: '9a2b53ba-df46-49f1-ad49-dd4637c752cd'
---

# Mozi CLI

> The coding agent that lives in your terminal.

墨子（Mozi）开源编码 Agent 的命令行界面——引擎可复用、多模型适配、事件开放。

## 安装

```bash
# npm
npm install -g mozi

# pnpm
pnpm add -g mozi

# 或直接 npx（无需安装）
npx mozi --help
```

## 快速开始

```bash
# 交互 REPL 模式
mozi

# 单次执行（非交互）
mozi "重构 src/utils.ts，提取公共函数"

# NDJSON 事件流输出（适合管道集成）
mozi --json "修复所有 TypeScript 报错"

# 指定审批模式
mozi --policy-mode full-auto "运行测试并修复失败的用例"
```

## 环境变量配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MOZI_BASE_URL` | OpenAI 兼容 API 地址（如 DeepSeek/Qwen/GLM） | — |
| `MOZI_API_KEY` | API 密钥 | — |
| `MOZI_MODEL` | 模型名称 | `deepseek-chat` |
| `MOZI_SESSION_DIR` | 会话存储目录 | `~/.mozi/sessions` |
| `MOZI_TASKS_DIR` | 定时任务存储目录 | `~/.mozi/tasks` |
| `MOZI_DEVICES_FILE` | 远程设备注册表文件 | `~/.mozi/devices.json` |

未配置 `MOZI_BASE_URL` / `MOZI_API_KEY` 时自动进入离线演示模式。

### 连接 DeepSeek 示例

```bash
export MOZI_BASE_URL=https://api.deepseek.com/v1
export MOZI_API_KEY=sk-your-key-here
export MOZI_MODEL=deepseek-chat
mozi "为这个项目添加单元测试"
```

### 连接本地 Ollama

```bash
export MOZI_BASE_URL=http://localhost:11434/v1
export MOZI_API_KEY=ollama
export MOZI_MODEL=qwen2.5-coder:7b
mozi "解释这段代码的逻辑"
```

## 命令一览

### 主命令

```bash
mozi [prompt...]          # 省略 prompt → 交互 REPL；有 prompt → 单次执行
mozi sessions             # 列出本地会话
mozi serve                # 启动远程服务（headless）
mozi --help               # 帮助
mozi --version            # 版本
```

### 选项

| 选项 | 说明 |
|------|------|
| `--json` | 以 NDJSON 输出事件流（非交互模式） |
| `--session <id>` | 指定会话 ID（用于 resume） |
| `--policy-mode <mode>` | 审批模式：`readonly` / `auto` / `full-auto` |
| `--yes` | 非交互模式下自动批准所有工具调用 |

### 定时任务子命令

```bash
mozi task add --name "每日构建" --schedule "0 9 * * *" --prompt "run build"
mozi task list              # 列出所有定时任务
mozi task rm <id>           # 删除任务
mozi task enable <id>       # 启用任务
mozi task disable <id>      # 禁用任务
mozi task run <id>          # 立即执行一次
mozi task tick              # 手动触发一次调度检查
mozi task gc                # 清理过期运行记录
mozi task doctor            # 诊断任务配置问题
```

### 远程访问子命令

```bash
mozi serve --port 7777      # 启动远程服务
mozi serve --lan            # 仅局域网直连
mozi serve --relay <url>    # 经自托管中继

mozi device list            # 列出已配对设备
mozi device pair            # 生成配对码
mozi device revoke <id>     # 吊销设备
mozi device rename <id> <name>  # 重命名设备
```

## REPL 交互命令

| 命令 | 说明 |
|------|------|
| `<输入文本>` | 发送任务给 Agent |
| `exit` / `quit` | 退出 REPL |
| `/undo` | 撤销最近一次文件修改 |

## 架构

CLI 复用 `@mozi/core` 引擎（与桌面端共享同一引擎核心）：

```
mozi (CLI)
  ├── @mozi/core        — Agent 引擎：循环、上下文管理、会话、子智能体、任务调度
  ├── @mozi/providers   — 多模型适配：OpenAI 兼容 / Anthropic / Gemini
  ├── @mozi/tools       — 14 个内置工具：文件读写、搜索、Shell、Git、浏览器等
  ├── @mozi/protocol    — 远程设备协议：配对、注册、吊销
  └── @mozi/shared      — 共享类型与事件定义
```

## 许可证

MIT

> AI生成