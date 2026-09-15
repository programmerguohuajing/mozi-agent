/**
 * M16 记忆系统的文本处理工具：敏感信息检测（§16.5）、编辑距离、BM25 关键词检索。
 * 全部零原生依赖（ADR-008）：不引入 MiniSearch 等外部包，自实现 BM25。
 */

/** 常见密钥/token 模式（复用 M6 maskSecret 模式，§16.5）。 */
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / 通用 sk- 前缀
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  // GitHub token
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  // AWS Access Key
  /\bAKIA[0-9A-Z]{16}\b/,
  // Slack token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // JWT（三段 base64url）
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // 私钥块
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // 显式赋值形态：password= / token: / apiKey=
  /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{12,}/i,
  // 连接串中的密码
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@/i,
];

/** 检测文本是否含疑似密钥（§16.5：检测到 → 拒写）。 */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** 把疑似密钥替换为脱敏占位（用于 mozi memory export --redacted）。 */
export function redactSecret(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
      '[REDACTED]',
    );
  }
  return out;
}

/** Levenshtein 编辑距离（滚动数组，O(min(m,n)) 空间）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length] ?? 0;
}

/** 归一化编辑相似度 ∈ [0,1]（1 = 完全相同）。 */
export function editSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - editDistance(a, b) / max;
}

/** 余弦相似度（零向量返回 0）。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 中英混合分词：连续 CJK 按 2-gram 切分，ASCII 按单词切分（BM25 用）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // CJK 段抽 2-gram（覆盖中文无空格场景）
  for (const seg of lower.match(/[\u3000-\u9fff\uff00-\uffef]+/g) ?? []) {
    if (seg.length === 1) {
      tokens.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
  }
  // ASCII 单词/数字
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) tokens.push(w);
  return tokens;
}

/**
 * 纯 JS BM25 关键词检索（§16.3 降级链：无 embedding 配置时使用）。
 * k1/b 取经典值。
 */
export class Bm25Index {
  private readonly df = new Map<string, number>();
  private readonly docs: Array<{ id: string; len: number; tf: Map<string, number> }> = [];
  private avgLen = 0;

  private readonly k1 = 1.5;
  private readonly b = 0.75;

  add(id: string, text: string): void {
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ id, len: toks.length, tf });
    const total = this.docs.reduce((n, d) => n + d.len, 0);
    this.avgLen = total / this.docs.length;
  }

  /** 返回按 BM25 得分降序的 [id, score]，score>0 才保留。 */
  search(query: string, limit = 10): Array<{ id: string; score: number }> {
    const qToks = tokenize(query);
    const N = this.docs.length;
    if (!N || !qToks.length) return [];
    const scored = this.docs.map((d) => {
      let score = 0;
      for (const t of new Set(qToks)) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1));
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      return { id: d.id, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, limit);
  }
}

/**
 * 提取「实词」集合（用于中文改写判重的兜底路径）。
 * 在 bigram 基础上剔除高频通用词，使「同主题改写」的 Jaccard 高、
 * 而「同领域但不同事实」的 Jaccard 低。
 */
const GENERIC_TERMS = new Set([
  '我们',
  '这个',
  '那个',
  '一个',
  '使用',
  '采用',
  '需要',
  '可以',
  '应该',
  '以及',
  '进行',
  '通过',
  '说明',
  '内容',
  '项目',
  '保持',
  '执行',
  '约定',
]);

export function keyTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length < 2) continue; // 丢弃单字 CJK，降低噪声
    if (GENERIC_TERMS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** 粗略 token 估算（与 PromptAssembler 同口径，避免跨模块耦合复制一份）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
