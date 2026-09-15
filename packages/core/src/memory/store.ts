/**
 * M16 记忆存储（§16.2/§16.3/§16.5）。
 *
 * 存储布局（本地明文，不外发）：
 *   <userDir>/user.md                  L1 用户记忆（人可读 markdown + 内嵌 JSON 索引）
 *   <ws>/.mozi/memory/project.md       L2 项目记忆
 *   <ws>/.mozi/memory/semantic/*.jsonl L3 语义记忆（历史摘要 + embedding）
 *   <ws>/.mozi/memory/pending.jsonl    待确认候选记忆队列
 *
 * 本实现把条目结构化存为 .jsonl（便于机器读写），同时把人类可读镜像写入 .md，
 * 满足「本地明文存储」与「用户可直接查看编辑」两项要求。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../session/session-store.js';
import { type EmbeddingProvider, VectorStub } from './embedding.js';
import {
  Bm25Index,
  containsSecret,
  cosine,
  editSimilarity,
  estimateTokens,
  keyTerms,
  redactSecret,
} from './text-utils.js';
import {
  DEDUP_COSINE,
  DEDUP_EDIT_SIMILARITY,
  MEMORY_CAPS,
  MEMORY_INJECT_BUDGET,
  type MemoryEntry,
  type MemoryLayer,
  type MemorySource,
  type MemoryType,
  type MemoryWriteRequest,
  type MemoryWriteResult,
  type PendingMemory,
  RETRIEVAL_THRESHOLD,
  RETRIEVAL_TOP_K,
} from './types.js';

export interface MemoryStoreOptions {
  /** 工作区根（L2/L3 位置）。 */
  workspace: string;
  /** 用户级目录（默认 ~/.mozi/memory）。 */
  userDir?: string;
  /** 可变时钟（测试注入）。 */
  clock?: () => Date;
  /** id 生成器（测试注入，保证确定性）。 */
  idGen?: () => string;
  /** embedding provider（默认 VectorStub；上层可注入真实 provider）。 */
  embedding?: EmbeddingProvider;
  /** 自动写入（§16.2 路径③）；默认 false（走 pending 确认）。 */
  autoWrite?: boolean;
  /** 审计回调（§16.5：全部 memory 写/删进审计日志）。 */
  audit?: (ev: {
    op: 'write' | 'merge' | 'forget' | 'evict';
    entry: MemoryEntry | string;
    detail?: string;
  }) => void;
}

interface StoreFiles {
  userJsonl: string;
  projectJsonl: string;
  semanticJsonl: string;
  pendingJsonl: string;
  userMd: string;
  projectMd: string;
}

export class MemoryStore {
  private readonly files: StoreFiles;
  private readonly clock: () => Date;
  private readonly idGen: () => string;
  private readonly embedding: EmbeddingProvider;
  private readonly autoWrite: boolean;
  private readonly audit?: MemoryStoreOptions['audit'];

  /** 内存缓存（首次访问时懒加载）。 */
  private cache = new Map<MemoryLayer, MemoryEntry[]>();
  private loaded = false;
  private pending: PendingMemory[] = [];

  constructor(private readonly opts: MemoryStoreOptions) {
    const userDir = opts.userDir ?? path.join(os.homedir(), '.mozi', 'memory');
    const wsMem = path.join(opts.workspace, '.mozi', 'memory');
    this.files = {
      userJsonl: path.join(userDir, 'user.jsonl'),
      projectJsonl: path.join(wsMem, 'project.jsonl'),
      semanticJsonl: path.join(wsMem, 'semantic', 'entries.jsonl'),
      pendingJsonl: path.join(wsMem, 'pending.jsonl'),
      userMd: path.join(userDir, 'user.md'),
      projectMd: path.join(wsMem, 'project.md'),
    };
    this.clock = opts.clock ?? (() => new Date());
    this.idGen = opts.idGen ?? (() => `mem-${Math.random().toString(36).slice(2, 10)}`);
    this.embedding = opts.embedding ?? new VectorStub();
    this.autoWrite = opts.autoWrite ?? false;
    this.audit = opts.audit;
  }

  // ---------- 加载 / 持久化 ----------

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.cache.set('user', readJsonl<MemoryEntry>(this.files.userJsonl));
    this.cache.set('project', readJsonl<MemoryEntry>(this.files.projectJsonl));
    this.cache.set('semantic', readJsonl<MemoryEntry>(this.files.semanticJsonl));
    this.pending = readJsonl<PendingMemory>(this.files.pendingJsonl);
    this.loaded = true;
  }

  /** 强制重新从磁盘加载（跨进程写入后）。 */
  reload(): void {
    this.loaded = false;
    this.cache.clear();
    this.ensureLoaded();
  }

  private entries(layer: MemoryLayer): MemoryEntry[] {
    this.ensureLoaded();
    return this.cache.get(layer) ?? [];
  }

  private persist(layer: MemoryLayer): void {
    const list = this.entries(layer);
    const file =
      layer === 'user'
        ? this.files.userJsonl
        : layer === 'project'
          ? this.files.projectJsonl
          : this.files.semanticJsonl;
    writeJsonl(file, list);
    // 人可读镜像（用户可直接查看/编辑）
    if (layer === 'user') writeMd(this.files.userMd, list, '用户记忆（L1）');
    else if (layer === 'project') writeMd(this.files.projectMd, list, '项目记忆（L2）');
  }

  // ---------- 写入（三条路径） ----------

  /**
   * 路径① 显式写入（memory_write 工具 / 用户明确要求），source='user'。
   * 检测到密钥 → 拒写（§16.5）。返回写入结果（含是否合并、矛盾覆盖、LRU 淘汰）。
   */
  writeExplicit(req: MemoryWriteRequest, evidence?: string): MemoryWriteResult {
    return this.write(req, 'user', evidence ?? req.evidence);
  }

  /** 路径②③ 入库（确认后 / 自动），source 由调用方指定。 */
  write(
    req: MemoryWriteRequest | { layer: MemoryLayer; type: MemoryType; content: string },
    source: MemorySource,
    evidence?: string,
  ): MemoryWriteResult {
    const content = req.content.trim();
    if (!content) throw new Error('记忆内容为空，拒绝写入');
    if (containsSecret(content)) {
      throw new Error('检测到疑似密钥/token，记忆拒写（§16.5 敏感过滤）');
    }
    this.ensureLoaded();
    const layer = req.layer;
    const list = this.entries(layer);
    const now = this.clock().toISOString();

    // 去重与合并（§16.2）：相似 → 合并更新；矛盾 → 新覆盖旧，旧入 history。
    const dup = this.findSimilar(list, content);
    if (dup) {
      const before = dup.content;
      const merged = this.mergeContent(dup.content, content);
      dup.content = merged;
      dup.type = req.type;
      dup.updatedAt = now;
      dup.evidence = evidence ?? dup.evidence;
      // 若新内容与旧内容矛盾（编辑距离远但语义近）：把旧内容存入 history
      if (this.looksContradictory(before, content)) {
        dup.history = [
          ...(dup.history ?? []),
          { content: before, replacedAt: now, replacedBy: content },
        ];
      }
      this.persist(layer);
      this.audit?.({
        op: 'merge',
        entry: dup,
        detail: dup.history ? 'contradiction-overwrite' : 'dedup-merge',
      });
      return { entry: dup, merged: true, replaced: dup.history ? before : undefined };
    }

    const entry: MemoryEntry = {
      id: this.idGen(),
      layer,
      type: req.type,
      content,
      source,
      evidence,
      createdAt: now,
      updatedAt: now,
    };
    list.push(entry);
    this.persist(layer);
    this.audit?.({ op: 'write', entry });
    const evicted = this.enforceCap(layer);
    return { entry, merged: false, ...(evicted.length ? { evicted } : {}) };
  }

  /**
   * 路径② 半自动提取：候选写入 pending 队列（不直接入库）。
   * autoWrite=true 时（路径③）跳过队列直接入库，标 source='auto'。
   */
  submitCandidate(cand: Omit<PendingMemory, 'id' | 'createdAt'>): PendingMemory {
    if (containsSecret(cand.content)) {
      throw new Error('检测到疑似密钥/token，候选记忆丢弃（§16.5）');
    }
    const full: PendingMemory = {
      ...cand,
      id: this.idGen(),
      createdAt: this.clock().toISOString(),
    };
    if (this.autoWrite && full.suggestedLayer !== 'semantic') {
      this.write(
        { layer: full.suggestedLayer, type: full.type, content: full.content },
        'auto',
        full.evidence,
      );
      return full;
    }
    this.ensureLoaded();
    this.pending.push(full);
    writeJsonl(this.files.pendingJsonl, this.pending);
    this.audit?.({ op: 'write', entry: full.id, detail: 'pending-queue' });
    return full;
  }

  /** 列出待确认候选（会话启动时 UI 提示）。 */
  listPending(): PendingMemory[] {
    this.ensureLoaded();
    return [...this.pending];
  }

  /** 用户确认入库（逐条或全部）：转入 L1/L2，标 source='user-confirmed'。 */
  confirmPending(ids: string[]): MemoryWriteResult[] {
    this.ensureLoaded();
    const results: MemoryWriteResult[] = [];
    const keep: PendingMemory[] = [];
    for (const p of this.pending) {
      if (!ids.includes(p.id)) {
        keep.push(p);
        continue;
      }
      const layer: MemoryLayer = p.suggestedLayer === 'semantic' ? 'project' : p.suggestedLayer;
      results.push(
        this.write({ layer, type: p.type, content: p.content }, 'user-confirmed', p.evidence),
      );
    }
    this.pending = keep;
    writeJsonl(this.files.pendingJsonl, this.pending);
    return results;
  }

  /** 忽略候选（丢弃）。 */
  discardPending(ids: string[]): void {
    this.ensureLoaded();
    this.pending = this.pending.filter((p) => !ids.includes(p.id));
    writeJsonl(this.files.pendingJsonl, this.pending);
  }

  // ---------- L3 语义记忆 ----------

  /** 写入语义记忆条目（历史会话摘要），带 embedding。 */
  async writeSemantic(
    content: string,
    meta: { type?: MemoryType; source?: MemorySource; evidence?: string } = {},
  ): Promise<MemoryEntry> {
    if (containsSecret(content)) throw new Error('检测到疑似密钥/token，语义记忆拒写');
    this.ensureLoaded();
    const [vec] = await this.embedding.embed([content]);
    const now = this.clock().toISOString();
    const entry: MemoryEntry = {
      id: this.idGen(),
      layer: 'semantic',
      type: meta.type ?? 'fact',
      content: content.trim(),
      source: meta.source ?? 'auto',
      evidence: meta.evidence,
      createdAt: now,
      updatedAt: now,
      embedding: vec,
    };
    this.entries('semantic').push(entry);
    this.persist('semantic');
    this.audit?.({ op: 'write', entry });
    return entry;
  }

  // ---------- 检索 ----------

  /** 关键词检索（同步，BM25；覆盖 memory_search 工具与降级路径）。 */
  search(
    query: string,
    opts: { layer?: MemoryLayer; limit?: number } = {},
  ): Array<{ entry: MemoryEntry; score: number }> {
    this.ensureLoaded();
    const layers: MemoryLayer[] = opts.layer ? [opts.layer] : ['user', 'project', 'semantic'];
    const idx = new Bm25Index();
    const byId = new Map<string, MemoryEntry>();
    for (const l of layers) {
      for (const e of this.entries(l)) {
        idx.add(e.id, e.content);
        byId.set(e.id, e);
      }
    }
    const limit = opts.limit ?? RETRIEVAL_TOP_K;
    const hits = idx.search(query, limit);
    // 命中计数用于冷记忆降权（§16.3 feedback）
    for (const h of hits) {
      const e = byId.get(h.id);
      if (e) e.hits = (e.hits ?? 0) + 1;
    }
    return hits.map((h) => ({ entry: byId.get(h.id)!, score: h.score })).filter((x) => x.entry);
  }

  /**
   * 语义检索（向量优先，无 embedding 配置 → BM25 降级）。
   * 返回 top-k（相似度阈值 0.7）+ 使用的检索方式（诊断）。
   */
  async retrieve(
    query: string,
    opts: { topK?: number; threshold?: number } = {},
  ): Promise<{ hits: Array<{ entry: MemoryEntry; score: number }>; mode: 'vector' | 'bm25' }> {
    this.ensureLoaded();
    const semantic = this.entries('semantic');
    const topK = opts.topK ?? RETRIEVAL_TOP_K;
    const threshold = opts.threshold ?? RETRIEVAL_THRESHOLD;
    if (!semantic.length) return { hits: [], mode: 'vector' };

    const [qv] = await this.embedding.embed([query]);
    if (qv?.length) {
      const scored = semantic
        .filter((e) => e.embedding?.length)
        .map((e) => ({ entry: e, score: cosine(qv, e.embedding!) }))
        .filter((x) => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      if (scored.length) return { hits: scored, mode: 'vector' };
      // 向量全不达阈值 → 降级 BM25（覆盖「精确回忆」场景，§16.3）
    }
    const bm = this.search(query, { layer: 'semantic', limit: topK });
    return { hits: bm, mode: 'bm25' };
  }

  // ---------- 注入（L1/L2 全量 + 语义 top-k） ----------

  /**
   * 生成注入 L4 的记忆段（§16.3 格式）：
   *   L1/L2 全量（预算内截断） + <memories relevance="high"> 语义 top-k
   * untrusted（source='auto'）条目标注「自动学习，未经确认」。
   */
  buildInjection(session: Session, semanticHits: Array<{ entry: MemoryEntry }> = []): string {
    this.ensureLoaded();
    const sections: string[] = [];

    const userText = this.renderLayer(this.entries('user'), MEMORY_INJECT_BUDGET.user);
    if (userText) sections.push(userText);
    const projText = this.renderLayer(this.entries('project'), MEMORY_INJECT_BUDGET.project);
    if (projText) sections.push(projText);
    if (semanticHits.length) {
      const semText = this.renderLayer(
        semanticHits.map((h) => h.entry),
        MEMORY_INJECT_BUDGET.semantic,
      );
      if (semText) sections.push(semText);
    }
    if (!sections.length) return '';
    return `${sections.join('\n\n')}\n\n（以上为历史学习内容，如与项目约定冲突以约定为准）`;
  }

  private renderLayer(list: MemoryEntry[], budget: number): string {
    if (!list.length) return '';
    // 冷记忆降权：按 hits 升序 + updatedAt 升序 → 供 LRU 截断时优先丢冷的
    const ordered = [...list].sort((a, b) => {
      const h = (a.hits ?? 0) - (b.hits ?? 0);
      if (h !== 0) return h;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
    const lines: string[] = [];
    let used = 0;
    // 从「最新/最热」端向回收集，保证预算内优先保留高价值条目
    for (const e of [...ordered].reverse()) {
      const tag = e.source === 'auto' ? '（自动学习，未经确认）' : '';
      const line = `- [${e.type}] ${e.content}${tag}`;
      const cost = estimateTokens(line);
      if (used + cost > budget) break;
      lines.push(line);
      used += cost;
    }
    return lines.reverse().join('\n');
  }

  // ---------- 删除 ----------

  forget(id: string): boolean {
    this.ensureLoaded();
    for (const layer of ['user', 'project', 'semantic'] as MemoryLayer[]) {
      const list = this.entries(layer);
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) {
        const [removed] = list.splice(i, 1);
        this.persist(layer);
        this.audit?.({ op: 'forget', entry: removed ?? id });
        return true;
      }
    }
    return false;
  }

  /** 导出（可选脱敏，§16.5）。 */
  export(opts: { redacted?: boolean } = {}): {
    user: MemoryEntry[];
    project: MemoryEntry[];
    semantic: MemoryEntry[];
  } {
    this.ensureLoaded();
    const red = (list: MemoryEntry[]): MemoryEntry[] =>
      !opts.redacted ? list : list.map((e) => ({ ...e, content: redactSecret(e.content) }));
    return {
      user: red(this.entries('user')),
      project: red(this.entries('project')),
      semantic: red(this.entries('semantic')),
    };
  }

  // ---------- 内部：去重 / 矛盾 / LRU ----------

  private findSimilar(list: MemoryEntry[], content: string): MemoryEntry | undefined {
    const cjk = /[\u3000-\u9fff]/.test(content);
    // 中文：向量余弦（相似度够高才合并）。阈值见 DEDUP_COSINE。
    if (cjk && this.embedding instanceof VectorStub) {
      const qv = this.embedding.embedOne(content);
      let best: { e: MemoryEntry; s: number } | undefined;
      for (const e of list) {
        const s = cosine(qv, this.embedding.embedOne(e.content));
        if (s > DEDUP_COSINE && (!best || s > best.s)) best = { e, s };
      }
      if (best) return best.e;
      // 中文「同主题改写」兜底：要求主题实词高度重合（Jaccard ≥ 0.6），
      // 或存在明确的「变更/替代」语义词 + 核心主题词重合（矛盾覆盖场景）。
      const qTok = keyTerms(content);
      if (qTok.size >= 2) {
        for (const e of list) {
          const eTok = keyTerms(e.content);
          if (eTok.size < 2) continue;
          let inter = 0;
          for (const t of qTok) {
            if (eTok.has(t)) inter += 1;
          }
          const jaccard = inter / (qTok.size + eTok.size - inter);
          if (jaccard >= 0.6) return e;
          // 变更语义词（采用/改为/放弃/替换/切换/迁移）+ 主题词显著重合
          const CHANGE = /采用|改为|换成|放弃|替换|切换|迁移|改用/;
          if (CHANGE.test(content) && CHANGE.test(e.content) && inter >= 3) return e;
        }
      }
    }
    for (const e of list) {
      if (editSimilarity(e.content.toLowerCase(), content.toLowerCase()) >= DEDUP_EDIT_SIMILARITY) {
        return e;
      }
    }
    return undefined;
  }

  /** 合并两份内容：若一份是另一份的子串，取更长者；否则用分号连接去重。 */
  private mergeContent(oldC: string, newC: string): string {
    if (oldC.includes(newC)) return oldC;
    if (newC.includes(oldC)) return newC;
    const parts = [...oldC.split(/[；;。]/), ...newC.split(/[；;。]/)]
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set(parts)].join('；');
  }

  /** 判定为矛盾：不是简单追加而是改写（编辑相似度低但被判定为相似条目）。 */
  private looksContradictory(oldC: string, newC: string): boolean {
    const sim = editSimilarity(oldC.toLowerCase(), newC.toLowerCase());
    return sim < DEDUP_EDIT_SIMILARITY && !newC.includes(oldC) && !oldC.includes(newC);
  }

  /** 容量上限 LRU 淘汰（evidence 弱者优先，§16.2）。 */
  private enforceCap(layer: MemoryLayer): string[] {
    if (layer === 'semantic') return [];
    const cap = layer === 'user' ? MEMORY_CAPS.user : MEMORY_CAPS.project;
    const list = this.entries(layer);
    if (list.length <= cap) return [];
    // 排序键：有 evidence 优先保留；其次 hits 高优先；再次 updatedAt 新优先
    const ordered = [...list].sort((a, b) => {
      const ea = a.evidence ? 1 : 0;
      const eb = b.evidence ? 1 : 0;
      if (ea !== eb) return ea - eb; // evidence 弱者在前（优先淘汰）
      const h = (a.hits ?? 0) - (b.hits ?? 0);
      if (h !== 0) return h;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
    const evicted: string[] = [];
    const overflow = list.length - cap;
    for (let i = 0; i < overflow; i++) {
      const victim = ordered[i];
      if (!victim) break;
      const idx = list.indexOf(victim);
      if (idx >= 0) {
        list.splice(idx, 1);
        evicted.push(victim.id);
        this.audit?.({ op: 'evict', entry: victim, detail: 'lru-cap' });
      }
    }
    if (evicted.length) this.persist(layer);
    return evicted;
  }
}

// ---------- 文件辅助 ----------

function readJsonl<T>(file: string): T[] {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return [];
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

function writeJsonl(file: string, list: unknown[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = list.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(file, body ? `${body}\n` : '');
  } catch {
    /* persistence best-effort */
  }
}

function writeMd(file: string, list: MemoryEntry[], title: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      `# ${title}`,
      '',
      '> 由 mozi 记忆系统维护（M16）。可直接编辑，但格式变更可能被下次写入覆盖。',
      `> 共 ${list.length} 条。`,
      '',
    ];
    for (const e of list) {
      lines.push(`## [${e.type}] ${e.id}`);
      lines.push('');
      lines.push(e.content);
      lines.push('');
      lines.push(
        `- source: ${e.source}　created: ${e.createdAt}　updated: ${e.updatedAt}${e.evidence ? `　evidence: ${e.evidence}` : ''}`,
      );
      if (e.history?.length) {
        lines.push(`- history: ${e.history.length} 条被覆盖（可追溯）`);
      }
      lines.push('');
    }
    fs.writeFileSync(file, lines.join('\n'));
  } catch {
    /* best-effort */
  }
}
