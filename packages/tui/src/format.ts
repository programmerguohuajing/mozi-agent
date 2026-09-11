/**
 * 事件 → 可展示文本 的格式化器（TUI / CLI 共用）。
 *
 * 零依赖（不引 Ink）；TUI 只需把 formatEvent() 的输出打印到终端。
 * 每个事件一行（或两行），带 ANSI 颜色码可选。
 */
import type { AgentEvent } from '@mozi/shared';

export interface FormatOptions {
  /** ANSI 颜色（默认 false，纯文本）。 */
  colors?: boolean;
  /** 颜色实现（注入后 colors=true 生效）。 */
  colorize?: (text: string, color: 'gray' | 'green' | 'red' | 'yellow' | 'cyan' | 'magenta') => string;
  /** 截断长度（message/tool 结果），默认 80。 */
  lineWidth?: number;
}

/** token 统计行格式化：可独立调用，也可经 formatEvent 触发。 */
export function formatUsage(
  usage: { inputTokens: number; outputTokens: number; totalTokens?: number; costUsd?: number; model: string },
  opts?: { steps?: number; durationMs?: number },
): string {
  const parts: string[] = [];
  parts.push(`in=${usage.inputTokens}`);
  parts.push(`out=${usage.outputTokens}`);
  if (usage.totalTokens !== undefined && usage.totalTokens > 0) parts.push(`total=${usage.totalTokens}`);
  if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (opts?.steps !== undefined) parts.push(`${opts.steps} step(s)`);
  if (opts?.durationMs !== undefined) parts.push(`${Math.round(opts.durationMs / 1000)}s`);
  return parts.join(' · ');
}

/** 上下文压缩提示行。 */
export function formatCompacted(removedTurns: number, savedTokens: number): string {
  return `🗜  上下文已压缩：移除 ${removedTurns} 条消息，节省 ~${savedTokens} tokens`;
}

/** 子智能体完成行（含独立 usage）。 */
export function formatSubagentCompleted(
  usage: { totalTokens: number; costUsd?: number },
  steps: number,
  durationMs: number,
): string {
  const parts: string[] = [];
  parts.push(`${usage.totalTokens} tokens`);
  if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  parts.push(`${steps} step(s)`);
  parts.push(`${Math.round(durationMs / 1000)}s`);
  return `✔ 子智能体完成 · ${parts.join(' · ')}`;
}

/** 把单个 AgentEvent 格式化为一行文本（无输出返回 null）。 */
export function formatEvent(ev: AgentEvent, opts: FormatOptions = {}): string | null {
  const c = opts.colors && opts.colorize ? opts.colorize : (t: string) => t;
  const width = opts.lineWidth ?? 80;
  const short = (s: string): string => (s.length > width ? `${s.slice(0, width)}…` : s);

  switch (ev.type) {
    case 'turn.completed':
      return c(
        `[turn done · ${formatUsage(ev.usage, { steps: ev.steps })}]`,
        'cyan',
      );

    case 'context.compacted':
      return c(formatCompacted(ev.removedTurns, ev.savedTokens), 'magenta');

    case 'subagent.completed':
      return c(
        formatSubagentCompleted(ev.usage, ev.steps, ev.durationMs),
        'green',
      );

    case 'subagent.started':
      return c(`◐ ${ev.subSessionId.split('/').pop()} [${ev.agentType}] ${short(ev.prompt)}`, 'magenta');

    case 'subagent.failed':
      return c(`  ✗ 子智能体失败：${ev.error.code} ${ev.error.message}`, 'red');

    case 'token.usage':
      // 引擎侧 token.usage（快照/实时）——单独成行（较 turn.completed 更细粒度）
      return c(`  token · ${formatUsage(ev.usage)}`, 'gray');

    case 'message.completed':
      return null; // 消息体由调用方处理（流式 delta 拼接）

    case 'message.delta':
      return null; // 流式增量由调用方直接 write

    case 'tool.requested':
      return c(`→ ${ev.call.name}(${short(JSON.stringify(ev.call.arguments))})`, 'yellow');

    case 'tool.completed':
      return c(
        `  ${ev.result.isError ? '✗' : '✓'} ${ev.callId} ${short(ev.result.content)}`,
        ev.result.isError ? 'red' : 'green',
      );

    case 'tool.approval.required':
      return c(`⚠ 需要批准: ${ev.call.name}`, 'yellow');

    case 'task.completed':
      return c(`✅ task.completed (${ev.reason})`, 'green');

    case 'cost.warning':
      return c(`
⚠ ${ev.message}`, 'red');

    case 'error':
      return c(`✗ ${ev.error.code}: ${ev.error.message}`, 'red');

    case 'turn.started':
    case 'tool.started':
    case 'session.started':
    case 'session.resumed':
    case 'session.terminated':
    case 'subagent.queued':
    case 'subagent.progress':
    case 'subagent.approval.required':
    case 'tool.approval.resolved':
    case 'mcp.server.status':
    case 'mcp.sampling.requested':
    case 'mcp.sampling.resolved':
    case 'mcp.elicit.requested':
    case 'mcp.elicit.resolved':
    case 'internal.debug':
      return null; // 静默事件（调用方按需扩展）

    default: {
      // 穷举保护：新增事件类型不编译通过（除非此行 catch）
      const _exhaustive: never = ev;
      void _exhaustive;
      return null;
    }
  }
}