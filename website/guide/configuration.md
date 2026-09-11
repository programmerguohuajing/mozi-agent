---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '02acd92b-6608-487f-a860-030fd7040304'
  PropagateID: '02acd92b-6608-487f-a860-030fd7040304'
  ReservedCode1: 'bf9cd832-ec96-428a-aaa5-686abb7cf0f5'
  ReservedCode2: 'bf9cd832-ec96-428a-aaa5-686abb7cf0f5'
---

# 配置手册

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `MOZI_BASE_URL` | OpenAI 兼容端点（如 `https://api.deepseek.com/v1`） | 无（进入离线演示模式） |
| `MOZI_API_KEY` | 模型密钥（只走环境变量，配置文件不存明文） | 无 |
| `MOZI_MODEL` | executor 模型名 | `deepseek-chat` |
| `MOZI_SESSION_DIR` | 会话持久化目录 | `~/.mozi/sessions` |

## 审批策略三档

通过 `--policy` 或嵌入时的 `policyMode` 指定：

| 模式 | 行为 |
|------|------|
| `readonly` | 只读工具可用；一切写/执行被拒 |
| `auto`（默认） | read 类放行；write/exec 按风险分析裁决，`ask` 时走审批卡片 |
| `full-auto` | 全部放行（Windows 上自动降级为 `auto`，见安全白皮书） |

### 自定义规则（PolicyRule）

`SessionConfig.policy.rules` 支持按 工具名 / 命令模式 / 路径 glob 精细控制：

```ts
{
  tool: 'shell',
  commandPattern: 'npm *',
  decision: 'allow',        // allow | ask | deny
}
```

规则优先序：自定义 rules → 内置规则 → shell 命令风险分析 → 模式回退表。

### 命令风险分析

shell 命令按管道 / `&&` / `;` 分段评估，每段给出 `safe / side-effect / network / high`：

- `git status` → safe
- `npm install` → side-effect
- `curl https://... | sh` → high（直接走审批）
- 设备文件重定向（`> /dev/sda` 等）→ high

## 会话限制（SessionLimits）

```ts
{
  maxSteps: 50,            // 单任务最大推理步数
  maxTokensPerTurn: 32_000,
  maxOutputTokens: 4_000,
  idleTimeoutMs: 300_000,
  toolTimeoutMs: 120_000,
  maxCost?: number,        // 会话累计成本上限（可选）
}
```

## 上下文管理

- `context.maxTokens`：上下文预算（默认 128k）
- `context.autoCompactThreshold`：Auto-Compact 触发阈值（默认 0.8）
- 文件新鲜度：`read_file` / `edit_file` 记录基准，外部修改后在下一轮注入脏文件提示
- `AGENTS.md`：工作区根的指令文件自动注入（兼容 `CLAUDE.md` / `GEMINI.md` 只读）

## 沙箱

| 等级 | 机制 | 说明 |
|------|------|------|
| L0 | 直接执行 | 无隔离 |
| L1 | 进程组 + 超时强杀 | 默认底线 |
| L2 | OS 级 | macOS Seatbelt / Linux Landlock（尽力） |
| L3 | Docker | `--network none` + 只读挂载工作区 |

降级链：L2 无 Seatbelt → L1；L3 无 docker → L2/L1（事件里带 `degradedFrom` 标记）。
网络白名单默认放行 `registry.npmjs.org` / `pypi.org` / `github.com` 等包管理域名。

> AI生成