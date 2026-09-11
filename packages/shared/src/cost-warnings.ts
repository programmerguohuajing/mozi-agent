/**
 * 成本预警引擎（纯函数）：
 *   - 会话级：session.usage.costUsd ≥ perSessionUsd → 触发
 *   - 按天级：跨会话累计 costUsd ≥ perDayUsd → 触发
 *
 * 阈值来源：settings.costLimits（桌面端 SettingsPanel 可配置）。
 * 引擎每 turn.completed 后调用 evaluate；UI 侧订阅 'cost.warning' 事件展示。
 */
import type { TokenUsage } from './messages.js';

export interface CostLimits {
  /** 单会话成本上限（USD）。 */
  perSessionUsd?: number;
  /** 按天成本上限（USD）。 */
  perDayUsd?: number;
}

export interface CostWarning {
  /** 'session' | 'day'。 */
  scope: 'session' | 'day';
  /** 当前累计成本。 */
  costUsd: number;
  /** 配置的上限。 */
  limitUsd: number;
  /** 百分比（0-∞，超 100 表示超限）。 */
  percent: number;
  /** 建议动作文本（UI 直接展示）。 */
  message: string;
}

/** 评估会话级成本（每 turn.completed 后调用）。 */
export function checkSessionCost(usage: TokenUsage, limits: CostLimits): CostWarning | null {
  const limit = limits.perSessionUsd;
  if (limit === undefined || limit <= 0) return null;
  const costUsd = usage.costUsd ?? 0;
  if (costUsd < limit * 0.8) return null; // 低于 80% 不告警
  const percent = (costUsd / limit) * 100;
  return {
    scope: 'session',
    costUsd,
    limitUsd: limit,
    percent,
    message:
      percent >= 100
        ? `会话成本已超限：$${costUsd.toFixed(4)} / $${limit.toFixed(4)}（${percent.toFixed(0)}%），建议中止或提升上限`
        : `会话成本接近上限：$${costUsd.toFixed(4)} / $${limit.toFixed(4)}（${percent.toFixed(0)}%）`,
  };
}

/** 评估按天累计成本（聚合所有会话的 costUsd）。 */
export function checkDailyCost(dailyCostUsd: number, limits: CostLimits): CostWarning | null {
  const limit = limits.perDayUsd;
  if (limit === undefined || limit <= 0) return null;
  if (dailyCostUsd < limit * 0.8) return null;
  const percent = (dailyCostUsd / limit) * 100;
  return {
    scope: 'day',
    costUsd: dailyCostUsd,
    limitUsd: limit,
    percent,
    message:
      percent >= 100
        ? `今日累计成本已超限：$${dailyCostUsd.toFixed(4)} / $${limit.toFixed(4)}（${percent.toFixed(0)}%）`
        : `今日累计成本接近上限：$${dailyCostUsd.toFixed(4)} / $${limit.toFixed(4)}（${percent.toFixed(0)}%）`,
  };
}

/** 从多个会话的 usage 聚合今日成本（供 dashboard / 引擎调用）。 */
export function aggregateDailyCost(usageList: TokenUsage[]): number {
  return usageList.reduce((acc, u) => acc + (u.costUsd ?? 0), 0);
}