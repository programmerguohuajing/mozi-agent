---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6ba82260-f883-47bf-9498-b57a87aabd04'
  PropagateID: '6ba82260-f883-47bf-9498-b57a87aabd04'
  ReservedCode1: '9014b0f3-f880-4244-8dec-4b96477d508c'
  ReservedCode2: '9014b0f3-f880-4244-8dec-4b96477d508c'
---

# 评测 Benchmark

开源 Agent 的公信力来自**可复现的跑分**。墨子维护一套 30 任务自建评测集（`benchmark/`）。

## 任务分级

| 级别 | 数量 | 说明 |
|------|------|------|
| L1 单点修改 | 10 | 单文件缺陷修复（时区 / 边界 / 容错 / 命名…） |
| L2 跨文件功能 | 10 | 新增跨模块功能（分页 / 缓存 / 校验 / 限流 / i18n…） |
| L3 调试型 | 5 | 预埋 bug 的仓库，tests 全红，定位并修复 |
| L4 重构 | 5 | 结构性改造且保持行为不变（拆模块 / 迁 SDK / 去重…） |

每任务 = `task.md`（自然语言指令）+ `setup.mjs`（初始化仓库）+ `solution/`（参考解）+ `asserts/`（行为断言）。

## 两种模式

```bash
# smoke：setup → 应用参考解 → 断言必须全过。零 API 成本，验证评测集自洽（CI 每日跑）。
pnpm --filter @mozi/benchmark smoke

# live：真实模型跑分（成功率 / 步数 / token / 审批次数 / 耗时）。
MOZI_BENCH_BASE_URL=... MOZI_BENCH_API_KEY=... MOZI_BENCH_MODEL=... \
  pnpm --filter @mozi/benchmark live
```

跑分结果提交在仓库 `benchmark/results/`（JSON + Markdown 汇总），本页趋势图随每日 CI 更新。

## 设计原则

- **任务可解性有底线**：每个任务都带参考解，参考解必须通过全部断言（smoke 模式 CI 强制）
- **断言验证行为而非文本**：跑代码、比对输出，不搞字符串匹配的「假通过」
- **L3 测试不许改**：调试型任务的测试文件在断言中锁定，防止「改测试交差」
- **跨平台**：任务准备用 Node 脚本而非 bash，Windows / macOS / Linux 同一套

## 最新结果

见仓库 [`benchmark/results/`](https://github.com/programmerguohuajing/mozi-agent/tree/master/benchmark/results)。
每日 CI 跑分累积后，此处将展示按模型分列的趋势数据。

> AI生成