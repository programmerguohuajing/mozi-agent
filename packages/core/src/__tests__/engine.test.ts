import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ApprovalGateway, SessionStore, autoApproveGateway, createEngine } from '@mozi/core';
import { ProviderRegistry, ScriptedProvider, type ScriptedTurn } from '@mozi/providers';
/**
 * M1 引擎集成测试（T7）：用 ScriptedProvider 确定性回放驱动 AgentEngine 跑通主循环。
 * 覆盖：完整写文件循环、策略审批（ask/deny）、readonly 静默拒绝、步数上限、中断、JSONL 回放。
 * 零 API 成本、零网络依赖，CI 秒级跑完。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 构造一个把 executor 指向 ScriptedProvider 的注册表。 */
function makeProvider(turns: ScriptedTurn[]): ProviderRegistry {
  const reg = new ProviderRegistry();
  const p = new ScriptedProvider(turns, 'scripted', 'scripted-model');
  reg.register(p);
  // 引擎默认用 defaultConfig().models.executor = 'deepseek-chat' 解析 provider
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-test-'));
  sessionDir = path.join(dir, 'sessions');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 把异步生成器全部收进数组，同时驱动其执行。 */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('AgentEngine M1 主循环', () => {
  it('runs a full loop: write_file then model_finished', async () => {
    const reg = makeProvider([
      {
        toolCalls: [
          {
            name: 'write_file',
            arguments: { path: 'hello.txt', content: 'world' },
            riskLevel: 'write',
          },
        ],
      },
      { content: 'done' },
    ]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
    });
    const events = await collect(engine.run({ sessionId: 's1', text: 'create hello.txt' }));

    const completed = events.find((e) => e.type === 'task.completed');
    expect(completed?.reason).toBe('model_finished');

    const toolDone = events.find((e) => e.type === 'tool.completed');
    expect(toolDone).toBeTruthy();
    expect((toolDone as { result: { isError: boolean } }).result.isError).toBe(false);

    // 工具确实落地了文件
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('world');
  });

  it('asks for approval on shell under auto, and honors a deny', async () => {
    // mv 是 side-effect 命令（风险分析 ask），echo 属 safe 白名单会直接放行
    const reg = makeProvider([
      {
        toolCalls: [{ name: 'shell', arguments: { command: 'mv a.txt b.txt' }, riskLevel: 'exec' }],
      },
      { content: 'done' },
    ]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('deny'),
      policyMode: 'auto',
    });
    const events = await collect(engine.run({ sessionId: 's2', text: 'run a command' }));

    const required = events.find((e) => e.type === 'tool.approval.required');
    expect(required).toBeTruthy();

    const resolved = events.find((e) => e.type === 'tool.approval.resolved');
    expect((resolved as { decision: string }).decision).toBe('deny');

    const toolDone = events.find((e) => e.type === 'tool.completed');
    expect((toolDone as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it('denies write under readonly without even asking', async () => {
    const reg = makeProvider([
      {
        toolCalls: [
          { name: 'write_file', arguments: { path: 'x.txt', content: 'y' }, riskLevel: 'write' },
        ],
      },
    ]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'readonly',
    });
    const events = await collect(engine.run({ sessionId: 's3', text: 'write' }));

    // readonly 下 write 直接 deny，不应出现审批请求
    expect(events.find((e) => e.type === 'tool.approval.required')).toBeFalsy();

    const toolDone = events.find((e) => e.type === 'tool.completed');
    expect(toolDone).toBeTruthy();
    const result = (toolDone as { result: { isError: boolean; meta?: { errorKind?: string } } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.meta?.errorKind).toBe('denied');
  });

  it('respects maxSteps (no infinite loop when model keeps calling tools)', async () => {
    const turns: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      toolCalls: [{ name: 'glob', arguments: { pattern: '**/*.ts' }, riskLevel: 'read' }],
    }));
    const reg = makeProvider(turns);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
    });
    const events = await collect(
      engine.run({ sessionId: 's4', text: 'loop', overrides: { limits: { maxSteps: 3 } } }),
    );

    // 每个模型步产出一个 message.completed；maxSteps=3 时应恰好执行 3 步后停下
    const steps = events.filter((e) => e.type === 'message.completed');
    expect(steps.length).toBe(3);
    // 步数耗尽后循环直接结束，不再补发 task.completed
    expect(events.find((e) => e.type === 'task.completed')).toBeFalsy();
  });

  it('interrupts cleanly on abort signal', async () => {
    const reg = makeProvider([{ content: 'hello world this is a reply' }]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
    });
    const ac = new AbortController();
    const gen = engine.run({ sessionId: 's5', text: 'interrupt me', signal: ac.signal });

    const out: unknown[] = [];
    let first = true;
    for await (const ev of gen) {
      out.push(ev);
      if (first) {
        first = false;
        ac.abort();
      }
    }

    const completed = out.find((e) => (e as { type: string }).type === 'task.completed');
    expect((completed as { reason: string }).reason).toBe('user_interrupt');
  });

  it('persists events to JSONL and resumes the session', async () => {
    const reg = makeProvider([
      {
        toolCalls: [
          {
            name: 'write_file',
            arguments: { path: 'replay.txt', content: 'persist' },
            riskLevel: 'write',
          },
        ],
      },
      { content: 'done' },
    ]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
    });
    await collect(engine.run({ sessionId: 's6', text: 'persist a file' }));

    // 新的 store 重放落盘事件
    const store = new SessionStore(sessionDir);
    const resumed = store.resume('s6');

    const toolMsg = resumed.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect((toolMsg as { isError: boolean }).isError).toBe(false);
    // 至少包含：user / assistant(toolcalls) / tool
    expect(resumed.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('abort during pending approval interrupts immediately (deny + user_interrupt)', async () => {
    // 场景：工具在等 UI 审批（request 永不 resolve），用户点「中止」。
    // 修复前：abort 信号被 awaitApproval 忽略，会话挂死到 10 分钟超时；
    // 修复后：立即按 deny 收尾，事件流以 task.completed(user_interrupt) 结束。
    const reg = makeProvider([
      {
        toolCalls: [{ name: 'shell', arguments: { command: 'mv a.txt b.txt' }, riskLevel: 'exec' }],
      },
      { content: 'done' },
    ]);
    // biome-ignore lint/style/useConst: 引擎创建后需回填给审批网关闭包，声明与赋值分离。
    let engine!: ReturnType<typeof createEngine>;
    // 挂起式审批网关：request 被调用的那一刻引擎已挂在审批等待上，
    // 在下一个 tick 触发 abort —— 若修复无效，本测试将挂满 10 分钟而超时失败。
    const hangingApproval: ApprovalGateway = {
      request: () =>
        new Promise<'allow' | 'deny'>((_resolve) => {
          queueMicrotask(() => engine.abort('s7', 'user_interrupt'));
          // 故意不 resolve：只有 abort 能解除等待。
        }),
      resolve: () => {},
    };
    engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: hangingApproval,
      policyMode: 'auto',
    });

    const out = await collect(engine.run({ sessionId: 's7', text: 'need approval' }));

    const required = out.find((e) => (e as { type: string }).type === 'tool.approval.required');
    expect(required).toBeTruthy();

    const resolved = out.find((e) => (e as { type: string }).type === 'tool.approval.resolved');
    expect((resolved as { decision: string }).decision).toBe('deny');

    const toolDone = out.find((e) => (e as { type: string }).type === 'tool.completed');
    expect((toolDone as { result: { isError: boolean } }).result.isError).toBe(true);

    const completed = out.find((e) => (e as { type: string }).type === 'task.completed');
    expect((completed as { reason: string }).reason).toBe('user_interrupt');
  });

  it('empty model response yields explicit error instead of silent completion', async () => {
    // 空 turn：无 content / toolCalls —— 修复前会静默 task.completed(model_finished)。
    const reg = makeProvider([{}]);
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: reg,
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
    });
    const events = await collect(engine.run({ sessionId: 's8', text: 'say something' }));

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    expect((err as { error: { message: string } }).error.message).toMatch(/空响应/);
    // 不应再有"正常完成"事件（错误必须可见）。
    expect(events.find((e) => e.type === 'task.completed')).toBeFalsy();
  });
});
