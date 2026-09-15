import type { ProviderRegistry } from '@mozi/providers';
/**
 * Headless 执行（M4.5 / M13 §13.6 ②③④）：组装无人值守引擎 → engine.run() → 事件收集 → 报告。
 * 复用 M1 全链路（工具/子智能体/MCP 可用）；审批一律 deny（ask 已被策略静态化，I1）。
 */
import type { AgentEvent, TokenUsage } from '@mozi/shared';
import type { AgentEngine } from '../engine/agent-engine.js';
import { autoApproveGateway } from '../engine/approve.js';
import { createEngine } from '../engine/factory.js';
import { UNATTENDED_SYSTEM_PROMPT } from './types.js';
import type { TaskSpec } from './types.js';
import { buildUnattendedPolicy, effectiveRunConfig } from './unattended.js';

export interface HeadlessOutcome {
  exitCode: number;
  finishReason: string | null;
  usage: TokenUsage | null;
  steps: number;
  toolCalls: number;
  summary: string;
  toolSummary: string[];
  error?: { code: string; message: string };
}

export interface HeadlessInput {
  spec: TaskSpec;
  runId: string;
  /** 执行目录（worktree / 快照 / 原工作区，取决于产物策略） */
  workspaceDir: string;
  providers: ProviderRegistry;
  sessionDir: string;
  /** 自定义无人值守 system prompt（模板优先；否则默认） */
  systemPrompt?: string;
  onEvent?: (ev: unknown) => void;
}

/** 组装无人值守引擎（策略合成 + deny 兜底审批 + 无人值守评估注入） */
export function createHeadlessEngine(input: HeadlessInput): AgentEngine {
  const cfg = effectiveRunConfig(input.spec.config);
  const policyBuild = buildUnattendedPolicy(input.spec.config.policy);
  const engine = createEngine({
    sessionDir: input.sessionDir,
    workspaceRoot: input.workspaceDir,
    providers: input.providers,
    approval: autoApproveGateway('deny'), // 兜底：任何残留 ask 一律拒绝
    policyMode: policyBuild.policyMode,
    systemPrompt: input.systemPrompt ?? UNATTENDED_SYSTEM_PROMPT,
    unattended: true,
    sandboxLevel: cfg.sandboxLevel as 0 | 1 | 2 | 3,
    enableSubAgents: true,
  });
  return engine;
}

/** 执行 headless 会话并收集运行结果 */
export async function runHeadless(input: HeadlessInput): Promise<HeadlessOutcome> {
  const cfg = effectiveRunConfig(input.spec.config);
  const policyBuild = buildUnattendedPolicy(input.spec.config.policy);
  const engine = createHeadlessEngine(input);

  const startedAt = Date.now();
  const timeoutMs = cfg.timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`task 超时 ${timeoutMs}ms`)), timeoutMs);

  const messages: string[] = [];
  const toolLog: string[] = [];
  let usage: TokenUsage | null = null;
  let steps = 0;
  let toolCalls = 0;
  let finishReason: string | null = null;
  let error: { code: string; message: string } | undefined;

  try {
    for await (const ev of engine.run({
      sessionId: input.runId,
      text: input.spec.prompt,
      overrides: {
        policy: { mode: policyBuild.policyMode, rules: policyBuild.rules },
        limits: { maxSteps: cfg.maxSteps },
      },
      signal: ac.signal,
    })) {
      input.onEvent?.(ev);
      if (ev.type === 'message.completed' && ev.message.content) {
        messages.push(ev.message.content);
      } else if (ev.type === 'tool.requested') {
        toolCalls += 1;
      } else if (ev.type === 'tool.completed') {
        const mark = ev.result.isError ? '✗' : '✓';
        toolLog.push(`${mark} ${ev.callId} ${short(ev.result.content, 120)}`);
      } else if (ev.type === 'turn.completed') {
        steps = ev.steps;
        usage = ev.usage;
      } else if (ev.type === 'task.completed') {
        finishReason = ev.reason;
      } else if (ev.type === 'error') {
        error = { code: ev.error.code, message: ev.error.message };
      }
    }
  } catch (e) {
    error = { code: 'ERR_TASK_RUN', message: String((e as Error).message ?? e) };
  } finally {
    clearTimeout(timer);
  }

  const timedOut = ac.signal.aborted;
  // 正常完成 = 模型结束（model_finished）且无错误；其余（中断/错误/超时）视为失败退出码
  const exitCode = error ? 1 : timedOut ? 124 : finishReason === 'model_finished' ? 0 : 1;
  void startedAt;

  return {
    exitCode,
    finishReason: timedOut ? 'timeout' : finishReason,
    usage,
    steps,
    toolCalls,
    summary: messages[messages.length - 1] ?? '',
    toolSummary: toolLog,
    error,
  };
}

function short(text: string, n = 120): string {
  const first = text.split('\n')[0] ?? '';
  return first.length > n ? `${first.slice(0, n)}…` : first;
}
