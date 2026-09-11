---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6e2db31f-9f9c-44ca-b48f-7bbf64885c13'
  PropagateID: '6e2db31f-9f9c-44ca-b48f-7bbf64885c13'
  ReservedCode1: '0badf275-cd34-4cc2-9990-a848b49f437b'
  ReservedCode2: '0badf275-cd34-4cc2-9990-a848b49f437b'
---

## What does this PR do?

<!-- 一两句话说明变更目的与动机 -->

## Type of change

- [ ] fix — bug 修复
- [ ] feat — 新功能
- [ ] refactor — 重构（行为不变）
- [ ] docs — 文档
- [ ] chore — 构建 / CI / 依赖
- [ ] test — 测试

## Checklist

- [ ] `pnpm build` 全绿
- [ ] `pnpm test` 全绿（新模块必须同 PR 附带测试）
- [ ] `pnpm lint` 全绿（Biome）
- [ ] 提交信息符合中文 conventional commits（如 `feat(core): 新增 xxx`）
- [ ] 涉及 `packages/core` 的变更已阅读 `docs/` 架构文档
- [ ] 提示词 / 引擎行为变更：已跑 `pnpm --filter @mozi/benchmark smoke`，成功率无回退
- [ ] 版本号未擅自修改（发布走 changesets，版本由维护者决定）

## Additional context

<!-- 截图 / 设计文档链接 / 破坏性变更说明等 -->

> AI生成