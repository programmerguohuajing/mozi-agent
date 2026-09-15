/**
 * M16 记忆管理器（§16.2 路径②触发条件 + §16.3 检索时机 + §16.5 隐私/防投毒）。
 *
 * 职责：
 *  - 实现 ContextManager 的 MemoryInjector（buildInjection）
 *  - 管理「每 5 轮」语义检索刷新的节流
 *  - 判定半自动提取触发条件（任务完成 + 会话 token > 20k + 含新事实信号）
 *  - 会话启动时暴露 pending 候选供 UI 提示
 */
import type { Session } from '../session/session-store.js';
import type { MemoryStore } from './store.js';
import type { MemoryEntry, PendingMemory } from './types.js';

/** 半自动提取触发阈值（§16.2 路径②）。 */
export const EXTRACT_MIN_SESSION_TOKENS = 20_000;
/** 语义检索刷新间隔（§16.3：会话启动与每 5 轮）。 */
export const SEMANTIC_RETRIEVAL_EVERY_TURNS = 5;

/** 新事实信号（中文/英文关键词，粗筛，降低成本）。 */
const FACT_SIGNALS = [
  /记住/,
  /以后(都|请)/,
  /我们(决定|选择|采用)/,
  /项目(用|使用|基于)/,
  /\bremember\b/i,
  /\bwe (decided|chose|use)\b/i,
  /\bconvention\b/i,
];

export interface MemoryExtractionCandidate {
  type: 'fact' | 'preference' | 'decision';
  content: string;
  evidence?: string;
  suggestedLayer: 'user' | 'project';
}

/** 便宜的模型提取器（由调用方注入；返回结构化候选）。 */
export type MemoryExtractor = (input: {
  session: Session;
  /** 最近的对话文本（已裁剪）。 */
  transcript: string;
}) => Promise<MemoryExtractionCandidate[]>;

export interface MemoryManagerOptions {
  store: MemoryStore;
  /** 半自动提取器（未注入则不启用路径②）。 */
  extractor?: MemoryExtractor;
  /** 是否启用半自动提取（默认 true，但需 extractor 存在）。 */
  enableSemiAuto?: boolean;
  /** 审计回调（会话启动确认/忽略）。 */
  onPendingDiscovered?: (pending: PendingMemory[]) => void;
}

export class MemoryManager {
  private lastRetrievalTurn = -1;
  private semanticHits: MemoryEntry[] = [];
  private readonly store: MemoryStore;
  private readonly extractor?: MemoryExtractor;
  private readonly enableSemiAuto: boolean;
  private readonly onPendingDiscovered?: (p: PendingMemory[]) => void;

  constructor(opts: MemoryManagerOptions) {
    this.store = opts.store;
    this.extractor = opts.extractor;
    this.enableSemiAuto = opts.enableSemiAuto ?? true;
    this.onPendingDiscovered = opts.onPendingDiscovered;
  }

  /** 会话启动：提示待确认候选（§16.2 路径② UI 提示点）。 */
  onSessionStart(): PendingMemory[] {
    const pending = this.store.listPending();
    if (pending.length) this.onPendingDiscovered?.(pending);
    return pending;
  }

  /** 实现 ContextManager.MemoryInjector：把 L1/L2 全量 + 语义 top-k 注入 L4。 */
  buildInjection(session: Session): string {
    return this.store.buildInjection(
      session,
      this.semanticHits.map((entry) => ({ entry })),
    );
  }

  /**
   * 每轮调用：按轮数节流刷新语义检索（会话启动 + 每 5 轮，§16.3）。
   * @param turnIndex 当前轮序号（从 0 开始）
   * @param query 当前任务文本
   */
  async onTurn(turnIndex: number, query: string): Promise<void> {
    if (turnIndex === 0 || turnIndex - this.lastRetrievalTurn >= SEMANTIC_RETRIEVAL_EVERY_TURNS) {
      const { hits } = await this.store.retrieve(query);
      this.semanticHits = hits.map((h) => h.entry);
      this.lastRetrievalTurn = turnIndex;
    }
  }

  /** 供测试/诊断：当前注入的语义条目。 */
  currentSemanticHits(): MemoryEntry[] {
    return [...this.semanticHits];
  }

  /**
   * turn 结束后尝试半自动提取（§16.2 路径②触发条件）：
   * 任务完成 + 会话 token > 20k + 内容含新事实信号 → 提取候选写 pending 队列。
   * @returns 本次提取的候选（空数组表示未触发）。
   */
  async maybeExtract(session: Session, transcript: string): Promise<PendingMemory[]> {
    if (!this.enableSemiAuto || !this.extractor) return [];
    if (session.usage.totalTokens < EXTRACT_MIN_SESSION_TOKENS) return [];
    if (!FACT_SIGNALS.some((re) => re.test(transcript))) return [];
    let cands: MemoryExtractionCandidate[] = [];
    try {
      cands = await this.extractor({ session, transcript });
    } catch {
      // 提取失败不影响主流程（§16.2 后台任务）
      return [];
    }
    const out: PendingMemory[] = [];
    for (const c of cands) {
      try {
        out.push(
          this.store.submitCandidate({
            type: c.type,
            content: c.content,
            evidence: c.evidence,
            suggestedLayer: c.suggestedLayer,
          }),
        );
      } catch {
        // 敏感内容拒写（§16.5）——跳过该条
      }
    }
    return out;
  }
}
