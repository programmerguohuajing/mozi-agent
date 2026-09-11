/**
 * M16 向量检索（§16.3，ADR-008 降级链）：
 *   首选：可配置 embedding provider（openai text-embedding-3-small / ollama nomic-embed-text）
 *   无配置：返回 undefined → 上层降级 BM25 关键词检索
 *
 * 测试用固定 embedding 桩（VectorStub）断言 top-k 与阈值；不在此模块发起真实网络请求。
 */

export interface EmbeddingProvider {
  readonly id: string;
  /** 维度（诊断用）。 */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * 测试/离线用确定性 embedding 桩：基于 token 哈希投影到固定维度。
 * 相同文本 → 相同向量；语义相近文本 → 向量相近（共享 token 多则余弦高）。
 */
export class VectorStub implements EmbeddingProvider {
  readonly id = 'vector-stub';

  constructor(readonly dim = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of text.toLowerCase().match(/[\u3000-\u9fff]|[a-z0-9_]+/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    // L2 归一化，使余弦 = 归一化点积
    const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }
}
