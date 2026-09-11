/**
 * M16 向量检索（§16.3，ADR-008 降级链）：
 *   首选：可配置 embedding provider（openai text-embedding-3-small / ollama nomic-embed-text）
 *   无配置：返回 undefined → 上层降级 BM25 关键词检索
 *
 * 测试用固定 embedding 桩（VectorStub）断言 top-k 与阈值；不在此模块发起真实网络请求。
 */

import { tokenize } from './text-utils.js';

export interface EmbeddingProvider {
  readonly id: string;
  /** 维度（诊断用）。 */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * 测试/离线用确定性 embedding 桩。
 *
 * 采用「每个 token → 一个稳定伪随机的稀疏签名向量」再按词频加权求和（random projection
 * 的轻量版）。相比把 token 直接哈希到单个桶，本方案的关键性质是：
 *   - 相同文本 → 完全相同向量（确定性）
 *   - 共享 token 越多 → 余弦越高（近似语义相似）
 *   - 无共享 token → 余弦 ≈ 0（不会因为哈希碰撞产生假相似）
 *
 * 这是为断言阈值/top-k 而设计的近似实现，其绝对余弦水平与真实 embedding 不同，
 * 生产环境应注入真实 provider（见 §16.3）。
 */
export class VectorStub implements EmbeddingProvider {
  readonly id = 'vector-stub';

  constructor(readonly dim = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      // 每 token 取 K 个稳定坐标，符号由另一个哈希决定（稀疏签名）
      const h1 = fnv1a(tok);
      const h2 = fnv1a(`s:${tok}`);
      const k = 4;
      for (let j = 0; j < k; j++) {
        const idx = Math.abs((h1 + j * h2) | 0) % this.dim;
        const sign = ((h1 >>> (j * 3)) & 1) === 0 ? 1 : -1;
        v[idx] = (v[idx] ?? 0) + sign;
      }
    }
    const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
