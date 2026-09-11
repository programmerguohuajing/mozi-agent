---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '35b5095b-7799-4b1f-acf0-97f5e2626fdd'
  PropagateID: '35b5095b-7799-4b1f-acf0-97f5e2626fdd'
  ReservedCode1: '0ecac878-4541-4d62-96f1-980694f61fd4'
  ReservedCode2: '0ecac878-4541-4d62-96f1-980694f61fd4'
---

# embed-minimal

**50 行代码把墨子引擎嵌进你自己的程序** —— 这是 mozi 与 Codex CLI / Claude Code 最大的差异点：引擎即产品（`@mozi/core` 是独立 npm 包，零 UI 依赖，Node ≥ 20）。

```bash
# 在仓库根目录
pnpm build                                  # 先构建 workspace 包
pnpm --filter @mozi/example-embed-minimal start
```

示例做了什么：

1. 准备一个工作区目录（引擎的所有读写都被限制在其中）
2. 注册 Provider（演示用 `ScriptedProvider` 确定性回放，零 API 成本；切真实模型只需换一行，见文件末尾注释）
3. `createEngine()` 组装引擎（策略、工具、上下文、会话持久化全自动）
4. `engine.run()` 事件流式消费——assistant 输出、工具执行、步数/token 用量全部实时可见
5. 会话自动落盘为 JSONL，可 resume / 回放 / fork

进阶：
- 自定义工具：见 `examples/custom-tool`
- CLI 完整用法：见文档站「引擎嵌入指南」

> AI生成