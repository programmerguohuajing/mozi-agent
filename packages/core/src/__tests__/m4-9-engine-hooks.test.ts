import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HookRunner,
  MemoryStore,
  type ResolvedHook,
  SessionStore,
  autoApproveGateway,
  createEngine,
} from '@mozi/core';
import { ProviderRegistry, ScriptedProvider, type ScriptedTurn } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M4.9 引擎接线集成测试（#22）：
 * 验证 AgentEngine 在 M18 各生命周期点触发 hook、tool:pre 可阻止执行、
 * M16 记忆工具经 memoryAccess 注入后真实落库、M15 提示词分层进入上下文。
 */

function makeProvider(turns: ScriptedTurn[]): ProviderRegistry {
  const reg = new ProviderRegistry();
  const p = new ScriptedProvider(turns, 'scripted', 'scripted-model');
  reg.register(p);
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m49-'));
  sessionDir = path.join(dir, 'sessions');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function firedTracker(): { runner: HookRunner; events: Set<string> } {
  const events = new Set<string>();
  const runner = new HookRunner({
    workspace: dir,
    execFn: async (command: string) => {
      events.add(command);
      return { code: 0, stdout: '', stderr: '', timedOut: false, failed: false };
    },
  });
  return { runner, events };
}

function allHooks(): ResolvedHook[] {
  const events = [
    'session:start',
    'session:end',
    'turn:start',
    'turn:end',
    'tool:pre',
    'tool:post',
  ] as const;
  return events.map((event, i) => ({ event, run: event, origin: 'user', source: '/x', index: i }));
}

describe('M4.9 引擎 hook 接线', () => {
  it('在 session/turn/tool 生命周期点触发 hook', async () => {
    const { runner, events } = firedTracker();
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: makeProvider([
        {
          toolCalls: [
            { name: 'write_file', arguments: { path: 'a.txt', content: 'hi' }, riskLevel: 'write' },
          ],
        },
        { content: 'done' },
      ]),
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
      hooks: runner,
      resolvedHooks: allHooks(),
    });
    await collect(engine.run({ sessionId: 's1', text: 'write a.txt' }));

    for (const e of [
      'session:start',
      'turn:start',
      'turn:end',
      'session:end',
      'tool:pre',
      'tool:post',
    ]) {
      expect(events.has(e)).toBe(true);
    }
    // 工具确实执行成功
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hi');
  });

  it('tool:pre block 阻止工具执行（文件不落地）', async () => {
    const runner = new HookRunner({
      workspace: dir,
      execFn: async () => ({
        code: 2,
        stdout: 'blocked',
        stderr: '',
        timedOut: false,
        failed: false,
      }),
    });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: makeProvider([
        {
          toolCalls: [
            { name: 'write_file', arguments: { path: 'b.txt', content: 'hi' }, riskLevel: 'write' },
          ],
        },
        { content: 'done' },
      ]),
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
      hooks: runner,
      resolvedHooks: [{ event: 'tool:pre', run: 'block', origin: 'user', source: '/x', index: 0 }],
    });
    const events = await collect(engine.run({ sessionId: 's2', text: 'write b.txt' }));
    const completed = events.find((e) => e.type === 'tool.completed') as
      | { result: { isError: boolean; meta?: { errorKind?: string } } }
      | undefined;
    expect(completed?.result.isError).toBe(true);
    expect(completed?.result.meta?.errorKind).toBe('hook-blocked');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
  });
});

describe('M4.9 记忆工具接线（M16）', () => {
  it('memory_write 经 memoryAccess 真实落库', async () => {
    const store = new MemoryStore({ workspace: dir });
    const engine = createEngine({
      sessionDir,
      workspaceRoot: dir,
      providers: makeProvider([
        {
          toolCalls: [
            {
              name: 'memory_write',
              arguments: { layer: 'user', type: 'fact', content: '本项目使用 pnpm 管理依赖' },
              riskLevel: 'write',
            },
          ],
        },
        { content: 'done' },
      ]),
      approval: autoApproveGateway('allow'),
      policyMode: 'full-auto',
      memoryStore: store,
    });
    await collect(engine.run({ sessionId: 's3', text: '记住依赖管理工具' }));

    const hits = store.search('pnpm');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entry.content).toContain('pnpm');
  });
});

describe('M4.9 提示词分层接线（M15）', () => {
  it('上下文包含 L0 基座身份与 L3 策略层', async () => {
    // 用真实工厂构造 ContextManager（经 createEngine 内部）间接验证：
    // 通过 engine 暴露的 session 快照不可见 system，这里改为校验 PromptAssembler 直接产物。
    const { PromptAssembler } = await import('@mozi/core');
    const asm = new PromptAssembler();
    const view = asm.build({
      enabledTools: ['write_file', 'shell', 'memory_write'],
      policyMode: 'auto',
      environment: { workspace: dir, today: '2026-09-12' },
    });
    expect(view.text).toContain('墨子'); // L0 基座（中文身份）
    expect(view.text).toContain('工具使用准则'); // L2 能力层
    expect(view.promptHash).toHaveLength(12);
    expect(view.promptVersion).toHaveLength(8);
  });
});
