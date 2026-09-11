import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HookRunner,
  type HookPayload,
  type HookRunnerOptions,
  globMatch,
  extractNote,
  loadHooks,
  approveProjectHooks,
  fingerprintFile,
  projectHooksPath,
  type ResolvedHook,
} from '@mozi/core';

/**
 * M18 Hooks 与生命周期插件测试（§18.7）：
 * 执行语义矩阵（退出码×onExit）、超时/崩溃/自动禁用、防投毒三不变式、note 注入、glob 匹配。
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m18-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 测试用 execFn 工厂 ──────────────────────────────────────────────

function makeRunner(
  execFn: NonNullable<HookRunnerOptions['execFn']>,
  opts: Partial<HookRunnerOptions> = {},
): HookRunner {
  return new HookRunner({ workspace: tmp, execFn, ...opts });
}

function makeHook(over: Partial<ResolvedHook> = {}): ResolvedHook {
  return {
    event: 'tool:pre',
    run: 'echo ok',
    origin: 'user',
    source: '/tmp/hooks.json',
    index: 0,
    ...over,
  };
}

type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; failed: boolean };

function fakeExec(result: Partial<ExecResult> = {}) {
  return async (): Promise<ExecResult> => ({
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    failed: false,
    ...result,
  });
}

// ── 1. 执行语义矩阵（退出码 × onExit） ────────────────────────────

describe('M18 执行语义矩阵（§18.4）', () => {
  it('exit 0 → continue', async () => {
    const r = makeRunner(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.action).toBe('continue');
  });

  it('exit 2 → block', async () => {
    const r = makeRunner(async () => ({ code: 2, stdout: '', stderr: 'forbidden', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.action).toBe('block');
  });

  it('exit 1 无 onExit → ask', async () => {
    const r = makeRunner(async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.action).toBe('ask');
  });

  it('exit 1 + onExit { "1": "block" } → block', async () => {
    const r = makeRunner(async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, failed: false }));
    const h = makeHook({ onExit: { '1': 'block', '*': 'ask' } });
    const [o] = await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.action).toBe('block');
  });

  it('exit 3 + onExit { "*": "continue" } → continue', async () => {
    const r = makeRunner(async () => ({ code: 3, stdout: '', stderr: '', timedOut: false, failed: false }));
    const h = makeHook({ onExit: { '*': 'continue' } });
    const [o] = await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.action).toBe('continue');
  });

  it('blocking 事件遇到 block 短路', async () => {
    let calls = 0;
    const r = makeRunner(async () => { calls++; return { code: 2, stdout: '', stderr: '', timedOut: false, failed: false }; });
    const hooks = [makeHook({ index: 0 }), makeHook({ index: 1 })];
    const outcomes = await r.run('tool:pre', hooks, { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(outcomes.length).toBe(1); // 第二个被短路
    expect(calls).toBe(1);
  });

  it('非 blocking 事件不短路（全执行）', async () => {
    let calls = 0;
    const r = makeRunner(async () => { calls++; return { code: 2, stdout: '', stderr: '', timedOut: false, failed: false }; });
    const hooks = [makeHook({ event: 'tool:post', index: 0 }), makeHook({ event: 'tool:post', index: 1 })];
    const outcomes = await r.run('tool:post', hooks, { tool: 'shell' }, { sessionId: 's1' });
    expect(outcomes.length).toBe(2);
    expect(calls).toBe(2);
  });
});

// ── 2. 超时 / 崩溃 / 自动禁用 ──────────────────────────────────────

describe('M18 超时与失败隔离（§18.4）', () => {
  it('超时 → onExit["*"] + 告警', async () => {
    let warned = false;
    const r = makeRunner(
      async () => ({ code: null, stdout: '', stderr: '', timedOut: true, failed: false }),
      { onWarning: () => { warned = true; } },
    );
    const h = makeHook({ onExit: { '*': 'continue' } });
    const [o] = await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.timedOut).toBe(true);
    expect(o!.action).toBe('continue');
    expect(warned).toBe(true);
  });

  it('进程崩溃/不存在 → onExit["*"]（默认 continue）', async () => {
    const r = makeRunner(async () => ({ code: null, stdout: '', stderr: 'ENOENT', timedOut: false, failed: true }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.failed).toBe(true);
    expect(o!.action).toBe('continue'); // 默认 fallback
  });

  it('连续失败 10 次自动禁用', async () => {
    let disabled = false;
    const r = makeRunner(
      async () => ({ code: null, stdout: '', stderr: '', timedOut: false, failed: true }),
      { onWarning: (_m, d) => { if (d && typeof d === 'object' && 'source' in d) disabled = true; } },
    );
    const h = makeHook();
    for (let i = 0; i < 10; i++) {
      await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    }
    expect(r.isDisabled(h)).toBe(true);
    // 第 11 次不执行
    const outcomes = await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(outcomes.length).toBe(0);
  });

  it('成功后失败计数清零', async () => {
    let fail = true;
    const r = makeRunner(async () => {
      const code = fail ? null : 0;
      const failed = fail;
      fail = false;
      return { code, stdout: '', stderr: '', timedOut: false, failed };
    });
    const h = makeHook();
    for (let i = 0; i < 9; i++) {
      await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    }
    expect(r.isDisabled(h)).toBe(false); // 9 次不够
    // 第 10 次成功 → 清零
    await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    // 再 9 次也不会禁用
    fail = true;
    for (let i = 0; i < 9; i++) {
      await r.run('tool:pre', [h], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    }
    expect(r.isDisabled(h)).toBe(false);
  });
});

// ── 3. note 注入链路 ──────────────────────────────────────────────

describe('M18 note 注入（§18.4）', () => {
  it('exit 0 + stdout {"note":"..."} → 提取 note', async () => {
    const r = makeRunner(async () => ({ code: 0, stdout: '{"note":"请检查错误处理"}', stderr: '', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.note).toBe('请检查错误处理');
  });

  it('exit 0 + 无 JSON → 无 note', async () => {
    const r = makeRunner(async () => ({ code: 0, stdout: 'done', stderr: '', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.note).toBeUndefined();
  });

  it('exit 2 → 无 note（即使 stdout 有 JSON）', async () => {
    const r = makeRunner(async () => ({ code: 2, stdout: '{"note":"test"}', stderr: '', timedOut: false, failed: false }));
    const [o] = await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(o!.note).toBeUndefined();
  });

  it('extractNote 单元测试', () => {
    expect(extractNote('{"note":"hello"}')).toBe('hello');
    expect(extractNote('output\n{"note":"world"}')).toBe('world');
    expect(extractNote('no json')).toBeUndefined();
    expect(extractNote('{"note":""}')).toBeUndefined();
    expect(extractNote('')).toBeUndefined();
  });
});

// ── 4. glob 匹配 ──────────────────────────────────────────────────

describe('M18 glob 匹配（§18.6）', () => {
  it('globMatch 基本模式', () => {
    expect(globMatch('*.ts', 'foo.ts')).toBe(true);
    expect(globMatch('*.ts', 'foo.js')).toBe(false);
    expect(globMatch('**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(globMatch('**/prod/**', 'src/prod/config.ts')).toBe(true);
    expect(globMatch('**/prod/**', 'src/dev/config.ts')).toBe(false);
    expect(globMatch('src/?/*.ts', 'src/a/x.ts')).toBe(true);
    expect(globMatch('src/?/*.ts', 'src/ab/x.ts')).toBe(false);
  });

  it('Windows 路径反斜杠归一化', () => {
    expect(globMatch('**/*.ts', 'src\\a\\b.ts')).toBe(true);
    expect(globMatch('src\\*.ts', 'src\\foo.ts')).toBe(true);
  });

  it('match.pathGlob 过滤', async () => {
    const r = makeRunner(fakeExec({ code: 0 }));
    const h = makeHook({ match: { pathGlob: '**/prod/**' } });
    const o1 = await r.run('tool:pre', [h], { tool: 'write_file', path: 'src/prod/config.ts' }, { sessionId: 's1', blocking: true });
    expect(o1.length).toBe(1);
    const o2 = await r.run('tool:pre', [h], { tool: 'write_file', path: 'src/dev/config.ts' }, { sessionId: 's1', blocking: true });
    expect(o2.length).toBe(0);
  });

  it('match.tool 过滤', async () => {
    const r = makeRunner(fakeExec({ code: 0 }));
    const h = makeHook({ match: { tool: 'shell' } });
    const o1 = await r.run('tool:pre', [h], { tool: 'shell', command: 'ls' }, { sessionId: 's1', blocking: true });
    expect(o1.length).toBe(1);
    const o2 = await r.run('tool:pre', [h], { tool: 'read_file' }, { sessionId: 's1', blocking: true });
    expect(o2.length).toBe(0);
  });

  it('match.commandPattern 过滤', async () => {
    const r = makeRunner(fakeExec({ code: 0 }));
    const h = makeHook({ match: { tool: 'shell', commandPattern: 'npm (test|run build)' } });
    const o1 = await r.run('tool:pre', [h], { tool: 'shell', command: 'npm test' }, { sessionId: 's1', blocking: true });
    expect(o1.length).toBe(1);
    const o2 = await r.run('tool:pre', [h], { tool: 'shell', command: 'rm -rf /' }, { sessionId: 's1', blocking: true });
    expect(o2.length).toBe(0);
  });
});

// ── 5. 防投毒（§18.5 三不变式） ────────────────────────────────────

describe('M18 防投毒（§18.5）', () => {
  it('项目级 hooks 首次 → needsApproval', () => {
    // 写项目级 hooks.json
    const hooksFile = projectHooksPath(tmp);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: [{ event: 'tool:pre', run: 'node evil.js' }],
    }));

    const result = loadHooks({ workspace: tmp, headless: false });
    expect(result.hooks.length).toBe(0); // 未确认，不加载
    expect(result.needsApproval).not.toBeNull();
    expect(result.needsApproval!.reason).toBe('first-time');
    expect(result.needsApproval!.commands).toEqual(['node evil.js']);
  });

  it('项目级 hooks 确认后 → 加载', () => {
    const hooksFile = projectHooksPath(tmp);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: [{ event: 'tool:post', run: 'prettier --write' }],
    }));
    const fp = fingerprintFile(hooksFile);
    approveProjectHooks(tmp, fp, ['prettier --write']);

    const result = loadHooks({ workspace: tmp, headless: false });
    expect(result.hooks.length).toBe(1);
    expect(result.hooks[0]!.origin).toBe('project');
    expect(result.needsApproval).toBeNull();
  });

  it('指纹变更 → 重新确认', () => {
    const hooksFile = projectHooksPath(tmp);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: [{ event: 'tool:pre', run: 'node a.js' }],
    }));
    approveProjectHooks(tmp, fingerprintFile(hooksFile), ['node a.js']);

    // 修改文件
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: [{ event: 'tool:pre', run: 'node b.js' }],
    }));

    const result = loadHooks({ workspace: tmp, headless: false });
    expect(result.hooks.length).toBe(0);
    expect(result.needsApproval!.reason).toBe('changed');
    expect(result.needsApproval!.commands).toEqual(['node b.js']);
  });

  it('headless/CI 忽略项目级 hooks', () => {
    const hooksFile = projectHooksPath(tmp);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: [{ event: 'tool:pre', run: 'node evil.js' }],
    }));

    const result = loadHooks({ workspace: tmp, headless: true });
    expect(result.hooks.length).toBe(0);
    expect(result.needsApproval).toBeNull();
    expect(result.warnings.some((w) => w.includes('headless'))).toBe(true);
  });

  it('用户级 hooks 直接加载（无需确认）', () => {
    const userFile = path.join(tmp, 'user-hooks.json');
    fs.writeFileSync(userFile, JSON.stringify({
      hooks: [{ event: 'turn:start', run: 'echo hi' }],
    }));
    // 用全新 workspace，避免其他测试残留的项目级 hooks 干扰
    const cleanWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m18-user-'));
    try {
      const result = loadHooks({ workspace: cleanWs, userHooksPath: userFile, headless: false });
      expect(result.hooks.length).toBe(1);
      expect(result.hooks[0]!.origin).toBe('user');
      expect(result.needsApproval).toBeNull();
    } finally {
      fs.rmSync(cleanWs, { recursive: true, force: true });
    }
  });

  it('非法 hook 定义跳过并记录 warning', () => {
    const userFile = path.join(tmp, 'user-hooks.json');
    fs.writeFileSync(userFile, JSON.stringify({
      hooks: [
        { event: 'unknown:event', run: 'echo x' }, // 非法事件
        { event: 'tool:pre' }, // 缺 run
        { event: 'tool:post', run: 'echo ok' }, // 合法
      ],
    }));

    const result = loadHooks({ workspace: tmp, userHooksPath: userFile, headless: false });
    expect(result.hooks.length).toBe(1);
    expect(result.warnings.length).toBe(2);
  });
});

// ── 6. 审计回调 ────────────────────────────────────────────────────

describe('M18 审计日志（§18.4）', () => {
  it('每次执行触发 audit 回调', async () => {
    const audited: unknown[] = [];
    const r = makeRunner(fakeExec({ code: 0 }), {
      audit: (ev) => audited.push(ev),
    });
    await r.run('tool:pre', [makeHook()], { tool: 'shell' }, { sessionId: 's1', blocking: true });
    expect(audited.length).toBe(1);
    const ev = audited[0] as { hook: ResolvedHook; outcome: { action: string } };
    expect(ev.hook.event).toBe('tool:pre');
    expect(ev.outcome.action).toBe('continue');
  });
});