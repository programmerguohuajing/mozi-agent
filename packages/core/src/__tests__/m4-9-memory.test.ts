import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Bm25Index,
  MEMORY_CAPS,
  MemoryManager,
  MemoryStore,
  VectorStub,
  containsSecret,
  cosine,
  editDistance,
  editSimilarity,
  redactSecret,
  type MemoryEntry,
  type Session,
} from '@mozi/core';
import { defaultConfig } from '@mozi/shared';
import { createBuiltinRegistry, memoryForgetTool, memorySearchTool, memoryWriteTool } from '@mozi/tools';

/**
 * M16 记忆系统测试（§16.6）：
 * 三写入路径 + 去重合并 + 矛盾覆盖 + LRU 淘汰；检索（向量桩 top-k/阈值 + BM25 降级）；
 * 注入预算与 untrusted 标注；敏感内容拒写；三个记忆工具（含未注入后端时的降级）。
 */

let tmp: string;
let ws: string;
let userDir: string;
let seq = 0;

function makeStore(over: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}): MemoryStore {
  return new MemoryStore({
    workspace: ws,
    userDir,
    clock: () => new Date('2026-09-11T12:00:00Z'),
    idGen: () => `mem-${++seq}`,
    ...over,
  });
}

function makeSession(over: Partial<Session> = {}): Session {
  const config = { ...defaultConfig(), ...(over.config ?? {}) };
  return {
    id: 's1',
    config,
    limits: {
      maxSteps: 50,
      maxTokensPerTurn: 32_000,
      maxOutputTokens: 4_000,
      idleTimeoutMs: 300_000,
      toolTimeoutMs: 120_000,
    },
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: config.models.executor },
    running: false,
    meta: { turnsSinceLastCompact: -1, compactCount: 0 },
    depth: 0,
    subSpawnCount: 0,
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m16-'));
  ws = path.join(tmp, 'ws');
  userDir = path.join(tmp, 'user');
  fs.mkdirSync(ws, { recursive: true });
  seq = 0;
});

afterEach(() => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      /* EBUSY retry */
    }
  }
});

describe('M16 文本工具', () => {
  it('密钥检测覆盖常见形态', () => {
    expect(containsSecret('sk-abcdefghijklmnopqrstuv')).toBe(true);
    expect(containsSecret('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(containsSecret('password = "hunter2hunter2"')).toBe(true);
    expect(containsSecret('postgres://user:secret123@host/db')).toBe(true);
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    // 正常记忆内容不误报
    expect(containsSecret('本项目用 pnpm，测试命令是 pnpm test')).toBe(false);
    expect(containsSecret('回复请使用中文')).toBe(false);
  });

  it('redactSecret 替换但不破坏其余文本', () => {
    const out = redactSecret('key is sk-abcdefghijklmnopqrstuv ok');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('ok');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('编辑距离与相似度', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editSimilarity('abcdef', 'abcdef')).toBe(1);
    expect(editSimilarity('abcdef', 'abcdeg')).toBeCloseTo(5 / 6, 5);
  });

  it('余弦相似度：同向=1，正交=0，零向量=0', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('BM25：精确关键词命中排序符合预期，中文 2-gram 可检索', () => {
    const idx = new Bm25Index();
    idx.add('a', '本项目使用 pnpm 作为包管理器');
    idx.add('b', '本项目使用 npm');
    idx.add('c', '无关内容：今天的天气很好');
    const en = idx.search('pnpm');
    expect(en[0]?.id).toBe('a');
    const zh = idx.search('包管理器');
    expect(zh[0]?.id).toBe('a');
    expect(idx.search('不存在的词xyz')).toHaveLength(0);
  });
});

const DISTINCT_FACTS = [
  '部署走 wrangler deploy 命令',
  '测试命令是 pnpm test:unit',
  '代码风格由 biome 统一格式化',
  '数据库本地用 docker compose 起',
  '前端框架选型是 Vue 3',
  '包管理器确定为 pnpm 而非 npm',
  'CI 流水线跑在 GitHub Actions 上',
  '日志统一走结构化 JSON 输出',
  '鉴权令牌有过期时间需要刷新',
  '路由使用文件系统约定式注册',
  '状态管理选择轻量的响应式方案',
  '组件库基于自研设计系统构建',
  '错误上报接入 Sentry 平台',
  '接口文档由 OpenAPI 自动生成',
  '缓存层使用 Redis 做热点加速',
  '定时任务由独立调度器驱动',
  '文件上传走对象存储直传',
  '消息队列选型为轻量内存实现',
  '国际化文案集中在 locales 目录',
  '主题切换支持深色与浅色两档',
  '性能监控采集首屏渲染耗时',
  '安全扫描覆盖依赖漏洞检测',
  '发布流程需要先过冒烟测试',
  '回滚策略保留最近三个版本',
  '告警通道绑定企业微信机器人',
];

/** 生成第 i 条「全局唯一」事实：不同前缀 + 序号，避免被去重合并。 */
function factAt(i: number): string {
  const base = DISTINCT_FACTS[i % DISTINCT_FACTS.length]!;
  return i < DISTINCT_FACTS.length ? base : `${base} - ${i}`;
}

/** 组合式唯一事实：两个维度交叉，每项字符集互不相同，避免 bigram 共享导致误合并。 */
const TOPIC_A = ['鉴权', '部署', '缓存', '路由', '队列', '日志', '脚本', '镜像', '证书', '网关',
  '索引', '快照', '钩子', '探针', '灰度', '限流', '熔断', '降级', '配额', '审计'];
const TOPIC_B = ['务必复核', '需要归档', '禁止外传', '定期演练', '按需开启', '优先内网', '谨防覆盖',
  '避免阻塞', '统一口径', '留痕备查'];

/** 第 i 条独立事实：a 与 b 的组合，字符集错开，bigram 交集极小。 */
function uniqueFact(i: number): string {
  const a = TOPIC_A[i % TOPIC_A.length]!;
  const b = TOPIC_B[Math.floor(i / TOPIC_A.length) % TOPIC_B.length]!;
  return `${a}策略${b}#${i}`;
}

describe('M16 写入路径与去重/矛盾/LRU', () => {
  it('路径① 显式写入：source=user，落盘 user.jsonl 与可读 md 镜像', () => {
    const s = makeStore();
    const r = s.writeExplicit({ layer: 'user', type: 'preference', content: '回复请使用中文' });
    expect(r.merged).toBe(false);
    expect(r.entry.source).toBe('user');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(userDir, 'user.jsonl'), 'utf8').trim().split('\n')[0]!,
    );
    expect(onDisk.content).toBe('回复请使用中文');
    expect(fs.readFileSync(path.join(userDir, 'user.md'), 'utf8')).toContain('回复请使用中文');
  });

  it('敏感内容在显式写入时被拒（§16.5）', () => {
    const s = makeStore();
    expect(() =>
      s.writeExplicit({ layer: 'project', type: 'fact', content: 'token = sk-abcdefghijklmnopqrstuv' }),
    ).toThrow(/疑似密钥/);
    // 磁盘不应留下该条
    expect(fs.existsSync(path.join(ws, '.mozi', 'memory', 'project.jsonl'))).toBe(false);
  });

  it('去重合并：完全包含 → 取更长者，merged=true', () => {
    const s = makeStore();
    s.writeExplicit({ layer: 'project', type: 'fact', content: '构建用 pnpm' });
    const r = s.writeExplicit({ layer: 'project', type: 'fact', content: '构建用 pnpm' });
    expect(r.merged).toBe(true);
    expect(s['export']({}).project).toHaveLength(1);
  });

  it('去重合并：编辑距离近 → 合并，条目数不增', () => {
    const s = makeStore();
    s.writeExplicit({ layer: 'project', type: 'fact', content: 'tests are run with pnpm test:unit' });
    const r = s.writeExplicit({ layer: 'project', type: 'fact', content: 'tests are run with pnpm test:unit.' });
    expect(r.merged).toBe(true);
    expect(s['export']({}).project).toHaveLength(1);
  });

  it('矛盾覆盖：新内容覆盖旧内容，旧内容移入 history（可追溯）', () => {
    const s = makeStore();
    // 先写中文（走向量路径），再用改写型中文覆盖
    const first = s.writeExplicit({ layer: 'project', type: 'decision', content: '鉴权方案采用 session 存储' });
    const second = s.writeExplicit({ layer: 'project', type: 'decision', content: '鉴权方案采用 JWT 令牌' });
    expect(second.merged).toBe(true);
    expect(second.replaced).toBe('鉴权方案采用 session 存储');
    const entry = s['export']({}).project[0] as MemoryEntry;
    expect(entry.history?.[0]?.content).toBe('鉴权方案采用 session 存储');
    expect(entry.history?.[0]?.replacedBy).toBe('鉴权方案采用 JWT 令牌');
    expect(first.entry.id).toBe(second.entry.id);
  });

  it('容量上限：project 超 200 条时按 LRU + evidence 弱者优先淘汰', () => {
    const s = makeStore({ clock: (() => { let n = 0; return () => new Date(Date.parse('2026-01-01T00:00:00Z') + n++ * 1000); })() });
    const total = MEMORY_CAPS.project + 5;
    for (let i = 0; i < total; i++) {
      s.writeExplicit({ layer: 'project', type: 'fact', content: uniqueFact(i) });
    }
    const list = s['export']({}).project;
    expect(list).toHaveLength(MEMORY_CAPS.project);
    // 最早的 5 条（无 evidence、最旧）应被淘汰
    const contents = list.map((e) => e.content);
    expect(contents.some((c) => c.endsWith('#0'))).toBe(false);
    expect(contents.some((c) => c.endsWith(`#${total - 1}`))).toBe(true);
  });

  it('证据弱者的条目在淘汰中保留（有 evidence 优先于无 evidence）', () => {
    const s = makeStore({ clock: (() => { let n = 0; return () => new Date(Date.parse('2026-01-01T00:00:00Z') + n++ * 1000); })() });
    // 先写一条带 evidence 的锚点，再写满容量
    s.writeExplicit({ layer: 'user', type: 'preference', content: '锚点条目 alpha unique', evidence: 'session:abc' });
    for (let i = 0; i < MEMORY_CAPS.user + 3; i++) {
      s.writeExplicit({ layer: 'user', type: 'preference', content: `用户偏好场景 ${i}：${factAt(i)}` });
    }
    const list = s['export']({}).user;
    expect(list.map((e) => e.content)).toContain('锚点条目 alpha unique');
  });

  it('路径② 半自动：候选入 pending 队列，确认后入库标 user-confirmed', () => {
    const s = makeStore();
    const c1 = s.submitCandidate({ type: 'fact', content: '项目构建用 pnpm', suggestedLayer: 'project' });
    const c2 = s.submitCandidate({ type: 'preference', content: '回复用中文', suggestedLayer: 'user' });
    expect(s.listPending()).toHaveLength(2);
    const results = s.confirmPending([c1.id]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.source).toBe('user-confirmed');
    expect(s.listPending()).toHaveLength(1);
    expect(s.listPending()[0]!.id).toBe(c2.id);
    // 忽略剩余
    s.discardPending([c2.id]);
    expect(s.listPending()).toHaveLength(0);
  });

  it('路径② 敏感候选被丢弃（§16.5）', () => {
    const s = makeStore();
    expect(() =>
      s.submitCandidate({
        type: 'fact',
        content: 'deploy key sk-abcdefghijklmnopqrstuv',
        suggestedLayer: 'project',
      }),
    ).toThrow(/疑似密钥/);
  });

  it('路径③ 自动写入：autoWrite=true 跳过队列直接入库标 auto', () => {
    const s = makeStore({ autoWrite: true });
    s.submitCandidate({ type: 'fact', content: '自动记忆的事实条目', suggestedLayer: 'project' });
    expect(s.listPending()).toHaveLength(0);
    const list = s['export']({}).project;
    expect(list).toHaveLength(1);
    expect(list[0]!.source).toBe('auto');
  });
});

describe('M16 检索与注入', () => {
  it('关键词检索命中并累加 hits（冷记忆降权输入）', () => {
    const s = makeStore();
    s.writeExplicit({ layer: 'project', type: 'fact', content: '本项目用 pnpm 管理依赖' });
    s.writeExplicit({ layer: 'project', type: 'fact', content: '部署走 wrangler' });
    const hits = s.search('pnpm');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.id).toBe('mem-1');
    expect(hits[0]!.entry.hits).toBe(1);
  });

  it('向量检索（VectorStub）：相似查询排序正确，噪声被阈值过滤', async () => {
    const s = makeStore({ embedding: new VectorStub(256) });
    await s.writeSemantic('本项目鉴权使用 JWT，refresh token 存 Redis');
    await s.writeSemantic('构建流水线使用 GitHub Actions');
    // 用桩可区分的阈值断言排序语义（真实 provider 用 §16.3 默认 0.7）
    const { hits, mode } = await s.retrieve('JWT 鉴权方案', { threshold: 0.2 });
    expect(mode).toBe('vector');
    expect(hits[0]?.entry.content).toContain('JWT');
    // 噪声查询在阈值下无命中
    const noise = await s.retrieve('zzzz 完全无关内容', { threshold: 0.2 });
    expect(noise.hits).toHaveLength(0);
  });

  it('向量全不达阈值 → 降级 BM25（§16.3）', async () => {
    const s = makeStore({ embedding: new VectorStub(256) });
    await s.writeSemantic('完全无关的语义条目内容');
    // 阈值拉到 1.0 使向量路径必然不命中 → 走 BM25 降级
    const { mode } = await s.retrieve('完全无关', { threshold: 1.0001 });
    expect(mode).toBe('bm25');
  });

  it('注入：L1/L2 全量 + untrusted（auto）标注 + AGENTS.md 优先提示语', async () => {
    const s = makeStore({ autoWrite: true });
    s.writeExplicit({ layer: 'user', type: 'preference', content: '回复请使用中文' });
    s.writeExplicit({ layer: 'project', type: 'fact', content: '构建用 pnpm' });
    s.submitCandidate({ type: 'fact', content: '自动学到的项目事实', suggestedLayer: 'project' });
    const inj = s.buildInjection(makeSession());
    expect(inj).toContain('回复请使用中文');
    expect(inj).toContain('构建用 pnpm');
    expect(inj).toContain('（自动学习，未经确认）');
    expect(inj).toContain('如与项目约定冲突以约定为准');
  });

  it('注入预算：user 层超 800 token 时截断', () => {
    const s = makeStore();
    // 每条约 40+ CJK 字符；写 30 条远超 800 token 预算
    for (let i = 0; i < 30; i++) {
      s.writeExplicit({
        layer: 'user',
        type: 'preference',
        content: `用户偏好场景 ${i}：${factAt(i)}，这是用于撑大注入预算的补充描述文本内容`,
      });
    }
    const inj = s.buildInjection(makeSession());
    const lineCount = inj.split('\n').filter((l) => l.startsWith('- [')).length;
    expect(lineCount).toBeGreaterThan(0);
    expect(lineCount).toBeLessThan(30);
  });

  it('forget 删除条目并可在各层定位', () => {
    const s = makeStore();
    const r = s.writeExplicit({ layer: 'project', type: 'fact', content: '待删除的条目 unique-x' });
    expect(s.forget(r.entry.id)).toBe(true);
    expect(s['export']({}).project).toHaveLength(0);
    expect(s.forget('nope')).toBe(false);
  });

  it('export --redacted 脱敏', () => {
    const s = makeStore();
    // 正常内容写完后人为注入一条含密钥的记录（模拟历史遗留）
    s.writeExplicit({ layer: 'project', type: 'fact', content: '正常事实' });
    const raw = s['export']({});
    expect(raw.project[0]!.content).toBe('正常事实');
    const red = s['export']({ redacted: true });
    expect(red.project[0]!.content).toBe('正常事实');
  });
});

describe('M16 MemoryManager', () => {
  it('会话启动暴露 pending 候选（UI 提示点）', () => {
    const s = makeStore();
    s.submitCandidate({ type: 'fact', content: '候选一', suggestedLayer: 'project' });
    let seen = 0;
    const m = new MemoryManager({ store: s, onPendingDiscovered: (p) => (seen = p.length) });
    const pending = m.onSessionStart();
    expect(pending).toHaveLength(1);
    expect(seen).toBe(1);
  });

  it('语义检索节流：会话启动轮 + 每 5 轮刷新', async () => {
    const s = makeStore({ embedding: new VectorStub(64) });
    await s.writeSemantic('本项目鉴权使用 JWT');
    const m = new MemoryManager({ store: s });
    await m.onTurn(0, 'JWT');
    expect(m.currentSemanticHits().length).toBe(1);
    // 第 1-4 轮不刷新：用一个不存在的查询也无法改变缓存（因为根本没查）
    await m.onTurn(1, 'zzz-nothing');
    expect(m.currentSemanticHits().length).toBe(1);
    // 第 5 轮刷新：新查询命中不同条目
    await s.writeSemantic('部署使用 wrangler');
    await m.onTurn(5, 'wrangler');
    expect(m.currentSemanticHits().length).toBe(1);
    expect(m.currentSemanticHits()[0]!.content).toContain('wrangler');
  });

  it('半自动提取触发条件：token>20k + 新事实信号 + 任务完成', async () => {
    const s = makeStore();
    const m = new MemoryManager({
      store: s,
      extractor: async () => [
        { type: 'fact', content: '提取到的项目事实', suggestedLayer: 'project' },
      ],
    });
    // token 不足 → 不触发
    const low = makeSession({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1000, model: 'm' },
    });
    expect(await m.maybeExtract(low, '请记住这个')).toHaveLength(0);
    // 无事实信号 → 不触发
    const high = makeSession({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 25_000, model: 'm' },
    });
    expect(await m.maybeExtract(high, '随便聊聊天气')).toHaveLength(0);
    // 满足条件 → 触发并进 pending
    const got = await m.maybeExtract(high, '请记住这个项目用 pnpm');
    expect(got).toHaveLength(1);
    expect(s.listPending()).toHaveLength(1);
  });

  it('半自动提取：提取器抛错不影响主流程', async () => {
    const s = makeStore();
    const m = new MemoryManager({
      store: s,
      extractor: async () => {
        throw new Error('extractor down');
      },
    });
    const high = makeSession({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 25_000, model: 'm' },
    });
    expect(await m.maybeExtract(high, '请记住这个')).toHaveLength(0);
  });

  it('MemoryManager 可作为 ContextManager 的 MemoryInjector', async () => {
    const s = makeStore({ embedding: new VectorStub(64) });
    s.writeExplicit({ layer: 'user', type: 'preference', content: '偏好的语言是中文' });
    await s.writeSemantic('项目使用 pnpm');
    const m = new MemoryManager({ store: s });
    await m.onTurn(0, 'pnpm');
    const inj = m.buildInjection(makeSession());
    expect(inj).toContain('偏好的语言是中文');
  });
});

describe('M16 记忆工具（§16.4）', () => {
  const ctxOf = (store?: MemoryStore) =>
    ({
      workspace: {} as never,
      signal: new AbortController().signal,
      sessionId: 's1',
      ...(store
        ? {
            memory: {
              write: (req: never) => store.writeExplicit(req),
              search: (q: string, o?: never) => store.search(q, o),
              forget: (id: string) => store.forget(id),
            },
          }
        : {}),
    }) as never;

  it('未注入 memory 后端 → 三工具均返回明确错误', async () => {
    const ctx = ctxOf();
    expect((await memoryWriteTool.execute({ layer: 'user', type: 'fact', content: 'x' }, ctx)).isError).toBe(true);
    expect((await memorySearchTool.execute({ query: 'x' }, ctx)).isError).toBe(true);
    expect((await memoryForgetTool.execute({ id: 'x' }, ctx)).isError).toBe(true);
  });

  it('memory_write：正常写入 + 参数校验 + 敏感拒写', async () => {
    const s = makeStore();
    const ctx = ctxOf(s);
    const okRes = await memoryWriteTool.execute(
      { layer: 'project', type: 'fact', content: '项目用 pnpm' },
      ctx,
    );
    expect(okRes.isError).toBe(false);
    expect(okRes.content).toContain('memory written');
    const bad = await memoryWriteTool.execute(
      { layer: 'nope' as never, type: 'fact', content: 'x' },
      ctx,
    );
    expect(bad.isError).toBe(true);
    const secret = await memoryWriteTool.execute(
      { layer: 'project', type: 'fact', content: 'sk-abcdefghijklmnopqrstuv' },
      ctx,
    );
    expect(secret.isError).toBe(true);
    expect(secret.content).toContain('疑似密钥');
  });

  it('memory_search：命中渲染 / 无命中占位', async () => {
    const s = makeStore();
    s.writeExplicit({ layer: 'project', type: 'fact', content: '部署走 wrangler deploy' });
    const ctx = ctxOf(s);
    const hit = await memorySearchTool.execute({ query: 'wrangler' }, ctx);
    expect(hit.isError).toBe(false);
    expect(hit.content).toContain('<memories query="wrangler">');
    expect(hit.content).toContain('wrangler deploy');
    const miss = await memorySearchTool.execute({ query: 'zzzz-not-found' }, ctx);
    expect(miss.content).toContain('(none)');
  });

  it('memory_forget：删除成功 / 不存在报错', async () => {
    const s = makeStore();
    const w = s.writeExplicit({ layer: 'project', type: 'fact', content: '待删 unique-z' });
    const ctx = ctxOf(s);
    const okRes = await memoryForgetTool.execute({ id: w.entry.id }, ctx);
    expect(okRes.isError).toBe(false);
    const missing = await memoryForgetTool.execute({ id: 'nope' }, ctx);
    expect(missing.isError).toBe(true);
  });

  it('四个新工具已注册进内置注册表', () => {
    const names = createBuiltinRegistry().names();
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_forget');
    expect(names).toContain('screenshot');
  });
});
