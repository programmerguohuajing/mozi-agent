---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd58af77a-0871-44c5-aefd-896d6c994a25'
  PropagateID: 'd58af77a-0871-44c5-aefd-896d6c994a25'
  ReservedCode1: 'd20b3e35-77d1-42b2-ba66-b9a6c10abab8'
  ReservedCode2: 'd20b3e35-77d1-42b2-ba66-b9a6c10abab8'
---

# Security Policy 安全策略

## Supported Versions 支持范围

| Version | Supported |
|---------|-----------|
| 0.x (main) | ✅ |

## Reporting a Vulnerability 漏洞报告

**Please do not report security vulnerabilities through public GitHub issues.**
请不要通过公开的 GitHub Issue 报告安全漏洞。

Instead, please use **GitHub private security advisories**:
请使用 GitHub 私有安全公告（仓库 Security 标签页 → Report a vulnerability），
或联系维护者。我们会在 **72 小时内**确认收到，并在修复后公开致谢（除非你希望匿名）。

报告时请尽量包含：

- 漏洞类型（如沙箱逃逸、路径穿越、提示注入、RCE）
- 复现步骤 / PoC
- 影响范围与严重性评估
- （可选）修复建议

## Scope 关注面

墨子是一个能执行命令与修改文件的编码 Agent，以下领域是安全设计的重点（详见文档站「安全模型白皮书」）：

- **四级沙箱**（L0–L3）与降级链路的完整性
- **命令风险分析**与审批策略（PolicyEngine）的绕过
- **apply_patch 的路径约束**（工作区逃逸 / symlink 攻击）
- **AGENTS.md / MCP server 内容注入**（不进 system prompt 的红线）
- **子智能体权限单调收紧**不变式
- **MCP Sampling / Elicitation** 反向请求的滥用防护
- **会话与快照数据**的本地存储安全

## Hardening Notes 加固说明

- 密钥只走环境变量，配置文件只存变量名
- CI 有依赖漏洞扫描（`pnpm audit`）
- Windows 上 full-auto 默认降级为 ask 策略（OS 沙箱受限）

> AI生成