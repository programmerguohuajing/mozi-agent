---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'f2c317c3-8ef9-46d0-8da8-4047c557eebd'
  PropagateID: 'f2c317c3-8ef9-46d0-8da8-4047c557eebd'
  ReservedCode1: 'e6309581-6b6d-4757-86c8-96ad8db2d072'
  ReservedCode2: 'e6309581-6b6d-4757-86c8-96ad8db2d072'
---

# Mozi Benchmark — 30 任务评测集

开源 Agent 的公信力来自可复现的跑分。本目录是 mozi 的自建评测集（技术方案 §8.3）。

## 任务分级

| 级别 | 数量 | 说明 |
|------|------|------|
| L1 单点修改 | 10 | 修复单文件内的缺陷（时区 / 边界 / 容错 / 命名…） |
| L2 跨文件功能 | 10 | 新增跨模块功能（分页 / 缓存 / 校验 / 限流 / i18n…） |
| L3 调试型任务 | 5 | 预埋 bug 的仓库，tests 全红，找到原因并修复 |
| L4 重构 | 5 | 结构性改造且保持行为不变（拆模块 / 迁 SDK / 去重…） |

## 任务结构

```
tasks/<id>/
  task.md          # 自然语言指令（评测时作为 agent 的输入）
  setup.mjs        # 初始化脚本：node setup.mjs <workspace>
  solution/        # 参考解（smoke 模式验证任务+断言自洽用）
  asserts/check.mjs # 断言：node check.mjs <workspace>，exit 0 = 通过
```

## 运行

```bash
# smoke 模式（默认）：setup → 应用参考解 → 断言必须全过。零 API 成本，验证评测集自洽。
pnpm --filter @mozi/benchmark smoke

# live 模式：真实模型跑分。需要环境变量：
#   MOZI_BENCH_BASE_URL  如 https://api.deepseek.com/v1
#   MOZI_BENCH_API_KEY   密钥
#   MOZI_BENCH_MODEL     如 deepseek-chat
MOZI_BENCH_BASE_URL=... MOZI_BENCH_API_KEY=... pnpm --filter @mozi/benchmark live

# 过滤
node runner/run.mjs --level L3          # 只跑某一级
node runner/run.mjs --task l3-debug-mutation
```

## 产出

`results/<timestamp>-<mode>.json`：每任务的成功率 / 步数 / token 成本 / 审批次数 / 耗时，
外加 `summary.md` 汇总表（按模型分列）。跑分结果提交进仓库，作为官网趋势图的数据源。

## 设计决策

- **跨平台**：任务准备用 `setup.mjs`（Node 脚本）而非 bash——CI 三平台 + Windows 本地都能跑。
- **smoke 先行**：参考解保证「任务可解 + 断言正确」，CI 每日零成本校验评测集自身不腐烂。
- **无人值守**：live 模式全走 `auto-approve` + full-auto 策略（评测语义：测能力不测审批 UX）。

> AI生成