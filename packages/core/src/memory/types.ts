/**
 * M16 记忆系统契约（§16.1/§16.2）。
 *
 * 三层记忆：
 *   L1 用户记忆  ~/.mozi/memory/user.md          全局偏好       注入 ≤800 token
 *   L2 项目记忆  <ws>/.mozi/memory/project.md    项目约定/坑/决策 注入 ≤1200 token
 *   L3 语义记忆  <ws>/.mozi/memory/semantic/     历史摘要+向量    检索 top-k ≤2000 token
 */

/** 记忆层（L3 语义层不在 memory_write 的直接目标内，由提取器写入）。 */
export type MemoryLayer = 'user' | 'project' | 'semantic';

/** 记忆类型（结构化）。 */
export type MemoryType = 'fact' | 'preference' | 'decision';

/**
 * 信任分级（§16.5）：决定注入时是否打「自动学习，未经确认」标注。
 *   user / user-confirmed → trusted（直接注入）
 *   auto                  → untrusted（注入时标注）
 */
export type MemorySource = 'user' | 'user-confirmed' | 'auto';

export interface MemoryEntry {
  /** 稳定 id（用于 memory_forget 与去重合并）。 */
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  content: string;
  source: MemorySource;
  /** 证据引用（对话位置/会话 id）；evidence 弱者优先被 LRU 淘汰。 */
  evidence?: string;
  /** 插入时间 ISO。 */
  createdAt: string;
  /** 最近一次被检索命中/合并的时间（LRU 用）。 */
  updatedAt: string;
  /** 被检索命中次数（冷记忆降权，§16.3）。 */
  hits?: number;
  /** 矛盾覆盖时，被新条目替代的旧内容（可追溯）。 */
  history?: Array<{ content: string; replacedAt: string; replacedBy: string }>;
  /** L3 语义记忆的向量（Float32Array 序列化后的 number[]）。 */
  embedding?: number[];
}

/** 待确认候选记忆（§16.2 路径②：半自动提取）。 */
export interface PendingMemory {
  id: string;
  type: MemoryType;
  content: string;
  evidence?: string;
  /** 建议归属层（提取器给出的判断）。 */
  suggestedLayer: MemoryLayer;
  createdAt: string;
}

/** 写入请求（memory_write 工具入参）。 */
export interface MemoryWriteRequest {
  layer: 'user' | 'project';
  type: MemoryType;
  content: string;
  evidence?: string;
}

/** 写入/合并结果。 */
export interface MemoryWriteResult {
  /** 落库后的最终条目。 */
  entry: MemoryEntry;
  /** 与既有条目合并（相似）还是新增。 */
  merged: boolean;
  /** 若发生矛盾覆盖，被覆盖的旧内容。 */
  replaced?: string;
  /** 被 LRU 淘汰的条目 id（容量上限触发）。 */
  evicted?: string[];
}

/** 容量上限（§16.2）。 */
export const MEMORY_CAPS = {
  user: 50,
  project: 200,
} as const;

/** 注入 token 上限（§16.1）。 */
export const MEMORY_INJECT_BUDGET = {
  user: 800,
  project: 1200,
  semantic: 2000,
} as const;

/** 去重合并阈值（§16.2：cosine > 0.85 或编辑距离近）。 */
export const DEDUP_COSINE = 0.85;
/** 编辑距离相似度阈值（归一化后）。 */
export const DEDUP_EDIT_SIMILARITY = 0.9;

/** 语义检索相似度阈值（§16.3：0.7）。 */
export const RETRIEVAL_THRESHOLD = 0.7;
/** 语义检索条数（§16.3：top-5）。 */
export const RETRIEVAL_TOP_K = 5;
