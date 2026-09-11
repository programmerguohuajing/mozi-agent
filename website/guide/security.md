---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c59d2446-ebb0-426d-b4c4-315f4f0a4b2b'
  PropagateID: 'c59d2446-ebb0-426d-b4c4-315f4f0a4b2b'
  ReservedCode1: 'f642940e-281e-4930-813a-1b6cb9768bdc'
  ReservedCode2: 'f642940e-281e-4930-813a-1b6cb9768bdc'
---

# 安全模型白皮书

墨子是一个**能执行命令与修改文件**的 Agent，安全不是功能项，是地基。本白皮书描述威胁模型与防护设计。

## 1. 四级沙箱（L0–L3）

| 等级 | 机制 | 适用 |
|------|------|------|
| L0 | 直接执行 | 受信任的只读命令 |
| L1 | 进程组 + 超时强杀 | 默认底线（防挂起、防失控） |
| L2 | OS 级 | macOS Seatbelt（sandbox-exec）/ Linux Landlock（尽力） |
| L3 | Docker | `--network none` + 工作区挂载，最强隔离 |

- **优雅降级**：L2 无 Seatbelt → L1；L3 无 docker → L2/L1。降级在事件 `meta.sandboxDegradedFrom` 中显式标记，绝不静默假装隔离。
- **网络白名单**：默认放行 `registry.npmjs.org` / `pypi.org` / `github.com` 等包管理域名，其余按 `allowNet` 配置。
- **Windows 现实**：成熟 OS 沙箱缺失 → `full-auto` 在 Windows 上默认降级为 `ask` 策略；文档引导用 Docker（L3）。

## 2. 审批策略（PolicyEngine）

- 三档模式：`readonly` / `auto` / `full-auto`，策略收紧方向单调。
- **命令风险分析**：按管道 / `&&` / `;` 分段，逐段评级（safe / side-effect / network / high），
  `curl | sh`、设备文件重定向等模式直接判 high。
- **规则优先序**：自定义 `PolicyRule`（tool / commandPattern / pathGlob）→ 内置规则 → 风险分析 → 模式回退。
- 审批卡片展示**结构化风险明细**（每段的评级与着色），不是一句干巴巴的「是否允许」。

## 3. 文件操作约束

- 所有工具的路径经 `Workspace.resolve` 约束在工作区内（路径穿越被拒）。
- 写入走 tmp+rename 原子写；`edit_file` 是**事务型**的：先全量只读匹配，再快照+写入，任一 hunk 失败整体拒绝并回滚。
- 每次成功编辑落会话级快照，`/undo` 可恢复（含撤销「新建文件」）。

## 4. 提示注入红线

外部内容（AGENTS.md / MCP server 返回 / 子智能体摘要）**永不进入 system prompt**：

- AGENTS.md 作为受控的独立层注入，工具描述由注册表统一托管
- MCP server 内容只出现在 user/tool 消息层
- MCP **Sampling**（server 借用 LLM）默认 deny，三档管控（deny/ask/allow）+ maxTokens 上限 + 模型限定在已配置 provider 内；子智能体中强制 deny
- **Elicitation**（server 向用户提问）表单冒泡 + 频控

## 5. 子智能体不变式

权限**单调收紧**：子 Agent 的策略取父与模板中更严者，工具白名单求交；
硬上限三重控制：`maxDepth=2` + `maxConcurrent=3` + `maxPerTurn=8`；
父会话中断时子树级联取消，审批冒泡到宿主统一裁决。

## 6. 密钥与数据

- 密钥只走环境变量（`apiKey: () => process.env.X`），配置文件只存变量名
- 会话 / 快照数据全部落在本机（`~/.mozi/`），无遥测
- 未来远程接入（M4.75）走端到端加密自托管中继：中继零内容（详见设计文档 M14 威胁模型）

## 7. 无人值守（定时任务，M4.5）

四重防护：`ask → deny` 静态化 + allowlist；worktree 产物隔离（默认不直改工作区）；
单次成本上限 + 超时强停；连续失败 ≥3 自动停用 + 通知。全部运行可审计可回放。

## 8. 漏洞报告

见 [SECURITY.md](https://github.com/programmerguohuajing/mozi-agent/blob/master/SECURITY.md)。
安全修复优先于一切功能迭代。

> AI生成