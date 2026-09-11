/**
 * ScriptedProvider（M4 §4.2 / M11）：确定性测试基建。
 * 录制真实模型的「逐轮响应序列」，离线回放驱动引擎——不花一分钱 API 费、CI 秒级跑完。
 */
import type { AssistantMessage, RiskLevel, TokenUsage, ToolCall } from '@mozi/shared';
import { chunkText } from './aggregator.js';
import { Stream } from './stream.js';
import type {
  ChatRequest,
  LLMProvider,
  LLMStream,
  ProviderCapabilities,
  StreamEvent,
} from './types.js';

export interface ScriptedToolCall {
  name: string;
  arguments: unknown;
  riskLevel?: RiskLevel;
}

export interface ScriptedTurn {
  content?: string;
  toolCalls?: ScriptedToolCall[];
  usage?: TokenUsage;
}

/** 多会话脚本（M12 §12.13）：按键匹配 sessionId 分派不同脚本，`*` 为通配。 */
export type ScriptedScenarios = Record<string, ScriptedTurn[]>;

export class ScriptedProvider implements LLMProvider {
  readonly id: string;
  private idx = 0;
  private readonly perSession = new Map<string, number>();
  private scenarios?: ScriptedScenarios;

  constructor(
    private readonly turns: ScriptedTurn[],
    id = 'scripted',
    private readonly model = 'scripted-model',
    scenarios?: ScriptedScenarios,
  ) {
    this.id = id;
    this.scenarios = scenarios;
  }

  /** 设置 / 追加多会话脚本（键可为 sessionId 或含 `*` 的模式）。 */
  setScenarios(scenarios: ScriptedScenarios): void {
    this.scenarios = scenarios;
    this.perSession.clear();
  }

  capabilities(): ProviderCapabilities {
    return {
      parallelToolCalls: true,
      vision: false,
      reasoning: false,
      maxContextTokens: 128_000,
      streamingToolArgs: true,
      systemPromptAsSeparateField: false,
    };
  }

  reset(): void {
    this.idx = 0;
    this.perSession.clear();
  }

  remaining(): number {
    return Math.max(0, this.turns.length - this.idx);
  }

  /** 按键匹配脚本：优先精确，其次 `*` 模式（左右通配）。 */
  private scriptFor(sessionId: string | undefined): ScriptedTurn[] | undefined {
    if (!this.scenarios) return undefined;
    if (sessionId && this.scenarios[sessionId]) return this.scenarios[sessionId];
    for (const [pattern, turns] of Object.entries(this.scenarios)) {
      if (pattern === '*') continue;
      if (globMatch(pattern, sessionId ?? '')) return turns;
    }
    return this.scenarios['*'];
  }

  private nextTurn(sessionId: string | undefined): ScriptedTurn {
    const script = this.scriptFor(sessionId);
    if (script) {
      const key = sessionId ?? '*';
      const i = this.perSession.get(key) ?? 0;
      this.perSession.set(key, i + 1);
      return script[i] ?? { content: '' };
    }
    return this.turns[this.idx++] ?? { content: '' };
  }

  chat(req: ChatRequest): LLMStream {
    const turn = this.nextTurn(req.sessionId);
    return new Stream(this.gen(turn), () => this.build(turn));
  }

  private async *gen(turn: ScriptedTurn): AsyncGenerator<StreamEvent> {
    if (turn.content) {
      for (const piece of chunkText(turn.content)) yield { type: 'text.delta', text: piece };
    }
    if (turn.usage) yield { type: 'usage', usage: turn.usage };
  }

  private build(turn: ScriptedTurn): AssistantMessage {
    const toolCalls: ToolCall[] | undefined = turn.toolCalls?.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.name,
      arguments: tc.arguments,
      riskLevel: tc.riskLevel ?? 'read',
    }));
    return {
      role: 'assistant',
      content: turn.content ?? null,
      toolCalls,
    };
  }
}

/** 简单通配匹配（`*` 匹配任意字符），用于 sessionId 脚本分派。 */
function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}
