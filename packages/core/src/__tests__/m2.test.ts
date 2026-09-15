import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FreshnessTracker,
  SessionStore,
  createEngine,
  createTemplateRegistry,
  intersectTools,
  tighten,
  truncateSummary,
} from '@mozi/core';
import { ProviderRegistry, ScriptedProvider, type ScriptedScenarios } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M2 集成测试（详细设计 §3.3.7 / §5.4 / §5.6 / M12）。
 * 覆盖：todo_list、文件新鲜度、Auto-Compact 接线、子智能体编排（模板/收紧/并发/审批冒泡/深度）。
 */

function makeRegistry(scenarios: ScriptedScenarios): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(new ScriptedProvider([], 'scripted', 'scripted-model', scenarios));
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m2-'));
  sessionDir = path.join(dir, 'sessions');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('todo_list 工具（§3.3.7）', () => {
  it('update 写入会话级 todo 并渲染清单', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            {
              name: 'todo_list',
              arguments: {
                operation: 'update',
                tasks: [
                  { id: '1', title: '修复登录 500', status: 'in_progress' },
                  { id: '2', title: '补单元测试', status: 'pending' },
                ],
              },
            },
          ],
        },
        { content: 'planned' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });
    const events = await collect(engine.run({ sessionId: 'todo1', text: 'plan' }));
    const done = events.find((e) => e.type === 'tool.completed');
    expect(done?.result.isError).toBe(false);
    expect(done?.result.content).toContain('[~] 1. 修复登录 500');
    expect(done?.result.content).toContain('[ ] 2. 补单元测试');
  });

  it('list 返回当前清单', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            {
              name: 'todo_list',
              arguments: { operation: 'update', tasks: [{ id: '1', title: 'A', status: 'done' }] },
            },
          ],
        },
        { toolCalls: [{ name: 'todo_list', arguments: { operation: 'list' } }] },
        { content: 'ok' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });
    const events = await collect(engine.run({ sessionId: 'todo2', text: 'go' }));
    const dones = events.filter((e) => e.type === 'tool.completed');
    expect(dones[1]?.result.content).toContain('[x] 1. A');
  });

  it('todo 状态持久化，resume 后可从 meta 恢复', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            {
              name: 'todo_list',
              arguments: {
                operation: 'update',
                tasks: [{ id: '1', title: '持久化任务', status: 'in_progress' }],
              },
            },
          ],
        },
        { content: 'done' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });
    await collect(engine.run({ sessionId: 'todo3', text: 'go' }));

    // 新 store 从 meta.json 恢复
    const store = new SessionStore(sessionDir);
    const resumed = store.resume('todo3');
    expect(resumed.meta.todos).toBeTruthy();
    expect((resumed.meta.todos as Array<{ title: string }>)[0]?.title).toBe('持久化任务');
  });
});

describe('文件新鲜度（§5.6）', () => {
  it('markRead → 修改 → checkDirty 命中并刷新基准', () => {
    const t = new FreshnessTracker();
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'v1');
    t.markRead(f);
    expect(t.checkDirty()).toEqual([]);
    fs.writeFileSync(f, 'v2-longer');
    expect(t.checkDirty()).toEqual([f]);
    expect(t.checkDirty()).toEqual([]);
  });

  it('文件删除也算脏', () => {
    const t = new FreshnessTracker();
    const f = path.join(dir, 'b.txt');
    fs.writeFileSync(f, 'x');
    t.markRead(f);
    fs.rmSync(f);
    expect(t.checkDirty()).toContain(f);
  });

  it('引擎在第二轮注入脏文件提示', async () => {
    const seen: string[] = [];
    const reg = new ProviderRegistry();
    const sp = new ScriptedProvider(
      [
        { toolCalls: [{ name: 'read_file', arguments: { path: 'w.txt' }, riskLevel: 'read' }] },
        { content: 'r1' },
        { content: 'r2' },
      ],
      'scripted',
      'scripted-model',
    );
    const orig = sp.chat.bind(sp);
    sp.chat = (req) => {
      const sys = req.messages.find((m) => m.role === 'system');
      if (sys && typeof sys.content === 'string') seen.push(sys.content);
      return orig(req);
    };
    reg.register(sp);
    reg.alias('deepseek-chat', 'scripted');
    reg.alias('executor', 'scripted');
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });

    fs.writeFileSync(path.join(dir, 'w.txt'), 'v1');
    await collect(engine.run({ sessionId: 'f1', text: 'read w' }));
    fs.writeFileSync(path.join(dir, 'w.txt'), 'v2-changed');
    await collect(engine.run({ sessionId: 'f1', text: 'again' }));

    expect(seen[0]).not.toContain('自上次读取后已被修改');
    expect(seen[seen.length - 1]).toContain('自上次读取后已被修改');
    expect(seen[seen.length - 1]).toContain('w.txt');
  });
});

describe('Auto-Compact 接线（§5.4）', () => {
  it('预算超阈触发 context.compacted 且任务可继续', async () => {
    const turns = [];
    for (let i = 0; i < 30; i++) {
      turns.push({
        content: `${'x'.repeat(3000)} s${i}`,
        toolCalls: [{ name: 'glob', arguments: { pattern: '**/*.ts' }, riskLevel: 'read' }],
      });
    }
    turns.push({ content: 'SUMMARY task=fix' });
    turns.push({ content: 'final' });
    const reg = makeRegistry({ '*': turns });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });
    const events = await collect(
      engine.run({
        sessionId: 'c1',
        text: 'long',
        overrides: { context: { maxTokens: 4000, autoCompactThreshold: 0.8 } },
      }),
    );
    const compacted = events.find((e) => e.type === 'context.compacted');
    expect(compacted).toBeTruthy();
    expect((compacted as { removedTurns: number }).removedTurns).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'task.completed')).toBe(true);
  });

  it('历史过短不触发压缩', async () => {
    const reg = makeRegistry({ '*': [{ content: 'hi' }] });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      enableSubAgents: false,
    });
    const events = await collect(engine.run({ sessionId: 'c2', text: 'short' }));
    expect(events.some((e) => e.type === 'context.compacted')).toBe(false);
  });
});

describe('子智能体：权限收紧纯函数（§12.6）', () => {
  it('tighten 取更严者', () => {
    expect(tighten('auto', 'readonly')).toBe('readonly');
    expect(tighten('full-auto', 'readonly')).toBe('readonly');
    expect(tighten('readonly', 'auto')).toBe('readonly');
    expect(tighten('full-auto', 'auto')).toBe('auto');
  });

  it('intersectTools 求交', () => {
    expect(intersectTools(['*'], ['read_file', 'grep'])).toEqual(['read_file', 'grep']);
    expect(intersectTools(['read_file', 'shell'], '*')).toEqual(['read_file', 'shell']);
    expect(intersectTools(['read_file', 'shell', 'grep'], ['read_file', 'grep', 'glob'])).toEqual([
      'read_file',
      'grep',
    ]);
  });
});

describe('子智能体：摘要截断（§12.9）', () => {
  it('超长时丢建议段、保结论段', () => {
    const short = truncateSummary('## 结论\nok');
    expect(short.truncated).toBe(false);
    const long = `## 结论\n${'内容'.repeat(3000)}\n## 相关文件\n- a.ts:1\n## 建议\n丢弃我`;
    const r = truncateSummary(long);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain('丢弃我');
    expect(r.text).toContain('## 结论');
  });
});

describe('子智能体：模板加载（§12.3）', () => {
  it('内置模板 + .mozi/agents 自定义模板', () => {
    fs.mkdirSync(path.join(dir, '.mozi', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.mozi', 'agents', 'db.md'),
      [
        '---',
        'type: db-migration',
        'description: migrations',
        'policy: auto',
        'tools: [read_file, shell]',
        'budget: 48k',
        '---',
        '你是迁移专家。',
      ].join('\n'),
    );
    const reg = createTemplateRegistry(dir);
    expect(reg.resolve('explore')?.policy).toBe('readonly');
    expect(reg.resolve('reviewer')?.allowedTools).toEqual(['read_file', 'glob', 'grep']);
    const custom = reg.resolve('db-migration');
    expect(custom?.policy).toBe('auto');
    expect(custom?.allowedTools).toEqual(['read_file', 'shell']);
    expect(custom?.contextBudgetTokens).toBe(48000);
    expect(custom?.systemPrompt).toContain('迁移专家');
  });
});

describe('子智能体：端到端 spawn（§12.4/§12.8/§12.10）', () => {
  it('task 派发 → 摘要回传 → 子日志落盘，主上下文仅增摘要', async () => {
    const live: string[] = [];
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            {
              name: 'task',
              arguments: { agent: 'explore', prompt: '找鉴权代码' },
              riskLevel: 'meta',
            },
          ],
        },
        { content: '主任务完成' },
      ],
      '*/subs/sub-*': [
        { toolCalls: [{ name: 'grep', arguments: { pattern: 'auth' }, riskLevel: 'read' }] },
        { content: '## 结论\n鉴权在 src/auth/jwt.ts\n## 相关文件\n- src/auth/jwt.ts:42' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      onEvent: (e) => live.push(e.type),
    });
    const events = await collect(engine.run({ sessionId: 'sub1', text: '调研' }));

    expect(live).toContain('subagent.started');
    expect(live).toContain('subagent.completed');
    expect(live).toContain('subagent.progress');

    const taskDone = events.find(
      (e) =>
        e.type === 'tool.completed' && (e.result.meta as { subSessionId?: string })?.subSessionId,
    );
    expect(taskDone).toBeTruthy();
    expect((taskDone as { result: { content: string } }).result.content).toContain(
      '<subagent type="explore"',
    );
    expect((taskDone as { result: { content: string } }).result.content).toContain('## 结论');
    expect((taskDone as { result: { isError: boolean } }).result.isError).toBe(false);

    const subLog = path.join(sessionDir, 'sub1', 'subs', 'sub-1', 'events.jsonl');
    expect(fs.existsSync(subLog)).toBe(true);
    const subText = fs.readFileSync(subLog, 'utf8');
    expect(subText).toContain('message.completed');
    // 子日志不含重复写入（单一事实源）
    expect(subText.split('\n').filter((l) => l.includes('"type":"turn.started"')).length).toBe(1);
  });

  it('深度超限 → isError 且不创建子会话', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            { name: 'task', arguments: { agent: 'general', prompt: 'x' }, riskLevel: 'meta' },
          ],
        },
        { content: 'done' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      subagent: { maxDepth: 0 },
    });
    const events = await collect(engine.run({ sessionId: 'd0', text: 'spawn' }));
    const rejected = events.find(
      (e) =>
        e.type === 'tool.completed' &&
        (e.result.meta as { errorKind?: string })?.errorKind === 'subagent-rejected',
    );
    expect(rejected).toBeTruthy();
    expect(fs.existsSync(path.join(sessionDir, 'd0', 'subs'))).toBe(false);
  });

  it('未知模板 → isError 且列出可用模板', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            { name: 'task', arguments: { agent: 'nope', prompt: 'x' }, riskLevel: 'meta' },
          ],
        },
        { content: 'done' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
    });
    const events = await collect(engine.run({ sessionId: 'u1', text: 'spawn' }));
    const rejected = events.find(
      (e) =>
        e.type === 'tool.completed' &&
        (e.result.meta as { errorKind?: string })?.errorKind === 'subagent-rejected',
    );
    expect((rejected as { result: { content: string } }).result.content).toContain('explore');
  });

  it('maxPerTurn 超限 → 第 3 个被拒', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            { name: 'task', arguments: { agent: 'explore', prompt: 'a' }, riskLevel: 'meta' },
            { name: 'task', arguments: { agent: 'explore', prompt: 'b' }, riskLevel: 'meta' },
            { name: 'task', arguments: { agent: 'explore', prompt: 'c' }, riskLevel: 'meta' },
          ],
        },
        { content: 'done' },
      ],
      '*/subs/sub-*': [{ content: '## 结论\nok' }],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
      subagent: { maxPerTurn: 2 },
    });
    const events = await collect(engine.run({ sessionId: 'pt1', text: 'spawn 3' }));
    const rejected = events.filter(
      (e) =>
        e.type === 'tool.completed' &&
        (e.result.meta as { errorKind?: string })?.errorKind === 'subagent-rejected',
    );
    expect(rejected.length).toBe(1);
  });
});

describe('子智能体：权限收紧端到端（§12.6）', () => {
  it('full-auto 父 × explore 子写文件 → 被 readonly 拒绝', async () => {
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            { name: 'task', arguments: { agent: 'explore', prompt: '写文件' }, riskLevel: 'meta' },
          ],
        },
        { content: 'done' },
      ],
      '*/subs/sub-*': [
        {
          toolCalls: [
            {
              name: 'write_file',
              arguments: { path: 'evil.txt', content: 'x' },
              riskLevel: 'write',
            },
          ],
        },
        { content: '## 结论\n只读，未写' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'full-auto',
    });
    await collect(engine.run({ sessionId: 'tight1', text: 'spawn' }));

    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    const subLog = path.join(sessionDir, 'tight1', 'subs', 'sub-1', 'events.jsonl');
    expect(fs.readFileSync(subLog, 'utf8')).toContain('"errorKind":"denied"');
  });
});

describe('子智能体：审批冒泡（§12.7）', () => {
  it('子 ask → 宿主通道 subagent.approval.required → resolveApproval 放行', async () => {
    const live: Array<{ type: string; callId?: string; agentType?: string }> = [];
    // biome-ignore lint/style/useConst: engine 创建后才回填，宿主 onEvent 闭包需先引用。
    let engineRef: { resolveApproval: (s: string, c: string, d: 'allow' | 'deny') => void };
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            { name: 'task', arguments: { agent: 'general', prompt: 'run mv' }, riskLevel: 'meta' },
          ],
        },
        { content: 'done' },
      ],
      '*/subs/sub-*': [
        {
          toolCalls: [
            { name: 'shell', arguments: { command: 'mv a.txt b.txt' }, riskLevel: 'exec' },
          ],
        },
        { content: '## 结论\n已执行' },
      ],
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      policyMode: 'auto',
      onEvent: (e) => {
        live.push(e as { type: string; callId?: string; agentType?: string });
        if (e.type === 'subagent.approval.required') {
          engineRef.resolveApproval('bub1', e.callId, 'allow');
        }
      },
    });
    engineRef = engine;
    const events = await collect(engine.run({ sessionId: 'bub1', text: 'spawn' }));

    const bubble = live.find((e) => e.type === 'subagent.approval.required');
    expect(bubble).toBeTruthy();
    expect(bubble?.agentType).toBe('general');
    expect(typeof bubble?.callId).toBe('string');
    // 父流不应出现裸的（未包装）审批事件
    expect(events.some((e) => e.type === 'tool.approval.required')).toBe(false);
    expect(live.some((e) => e.type === 'subagent.completed')).toBe(true);
  });
});
