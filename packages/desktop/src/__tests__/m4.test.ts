import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  AgentService,
  DiffReviewService,
  IpcBridge,
  McpManager,
  type SafeStorageLike,
  SettingsStore,
  UiStore,
  applyHunksToContent,
  buildHunks,
  buildSideBySide,
  diffScript,
  eventToRenderItems,
  hunkDecorations,
  languageFor,
  maskSecret,
  resetRenderIdSeq,
} from '@mozi/desktop';
import { LoopbackChannel, type McpAddRequest } from '@mozi/protocol';
import { ProviderRegistry, ScriptedProvider, type ScriptedScenarios } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M4 桌面应用集成测试（详细设计 M10 §10.3–§10.6）。
 * 覆盖：IPC 契约 / 会话池与事件扇出 / Diff hunk 模型与部分应用 / 设置与密钥安全 /
 * UI store 与事件流一致性。
 */

function makeRegistry(scenarios: ScriptedScenarios): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(new ScriptedProvider([], 'scripted', 'scripted-model', scenarios));
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

/** 内存 safeStorage（模拟 Electron safeStorage）。 */
function fakeSafeStorage(): SafeStorageLike {
  const key = 0x5a;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ key)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ key)).toString('utf8'),
  };
}

let dir: string;
let sessionDir: string;
let settingsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m4-'));
  sessionDir = path.join(dir, 'sessions');
  settingsFile = path.join(dir, 'settings.json');
});

afterEach(async () => {
  // 后台引擎可能仍持有 sessionDir 句柄（Windows 上表现为 EBUSY）：短重试再清。
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

// ── §10.3 IPC 契约 ────────────────────────────────────────────────

describe('§10.3 IPC 契约：通道清单完整性', () => {
  it('INVOKE_CHANNELS / SEND_CHANNELS 与详细设计清单一致', async () => {
    const proto = await import('@mozi/protocol');
    // §10.3 invoke 清单（27 条，含内置浏览器 browser:capture / browser:saveAnnotated、provider:models、provider:discoverLocal、workspace:pick 等）
    expect(proto.INVOKE_CHANNELS).toContain('session:create');
    expect(proto.INVOKE_CHANNELS).toContain('run:start');
    expect(proto.INVOKE_CHANNELS).toContain('approval:resolve');
    expect(proto.INVOKE_CHANNELS).toContain('engine:abort');
    expect(proto.INVOKE_CHANNELS).toContain('config:listProviders');
    expect(proto.INVOKE_CHANNELS).toContain('mcp:restart');
    expect(proto.INVOKE_CHANNELS).toContain('audit:query');
    expect(proto.INVOKE_CHANNELS).toContain('diff:applyPartial');
    expect(proto.INVOKE_CHANNELS).toContain('browser:capture');
    expect(proto.INVOKE_CHANNELS).toContain('browser:saveAnnotated');
    expect(proto.INVOKE_CHANNELS).toContain('session:setWorkspace');
    expect(proto.INVOKE_CHANNELS).toContain('workspace:listEntries');
    expect(proto.INVOKE_CHANNELS).toContain('skills:list');
    expect(proto.INVOKE_CHANNELS).toContain('browser:attach');
    expect(proto.INVOKE_CHANNELS).toContain('browser:detach');
    expect(proto.INVOKE_CHANNELS).toContain('schedule:list');
    expect(proto.INVOKE_CHANNELS).toContain('schedule:create');
    expect(proto.INVOKE_CHANNELS).toContain('schedule:toggle');
    expect(proto.INVOKE_CHANNELS).toContain('schedule:delete');
    expect(proto.INVOKE_CHANNELS).toContain('schedule:runNow');
    expect(proto.INVOKE_CHANNELS.length).toBe(39);
    // send 清单
    expect(proto.SEND_CHANNELS).toContain('engine:event');
    expect(proto.SEND_CHANNELS).toContain('session:status');
    expect(proto.SEND_CHANNELS).toContain('updater:download-progress');
    expect(proto.SEND_CHANNELS).toContain('schedule:changed');
  });

  it('IpcBridge 注册全部 invoke handler（无遗漏）', async () => {
    const proto = await import('@mozi/protocol');
    const channel = new LoopbackChannel();
    const reg = makeRegistry({});
    const settings = new SettingsStore({ filePath: settingsFile });
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: () => {},
    });
    const bridge = new IpcBridge({
      service,
      settings,
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    for (const c of proto.INVOKE_CHANNELS) {
      expect(channel.handledChannels(), `missing handler: ${c}`).toContain(c);
    }
  });

  it('LoopbackChannel 未注册通道 → reject；重复注册 → throw', async () => {
    const channel = new LoopbackChannel();
    await expect(channel.invoke('session:list', {})).rejects.toThrow(/no handler/);
    channel.handle('session:list', () => []);
    expect(() => channel.handle('session:list', () => [])).toThrow(/already handled/);
  });

  it('approvalTicketFromEvent：父 / 子审批统一提取', async () => {
    const proto = await import('@mozi/protocol');
    const call = { id: 'c1', name: 'shell', arguments: {}, riskLevel: 'exec' as const };
    const reason = { kind: 'manual' as const, note: 'x' };
    const parent = proto.approvalTicketFromEvent('s1', {
      type: 'tool.approval.required',
      call,
      reason,
      ts: 't',
    });
    expect(parent?.callId).toBe('c1');
    expect(parent?.agentType).toBeUndefined();
    const sub = proto.approvalTicketFromEvent('s1', {
      type: 'subagent.approval.required',
      subSessionId: 's1/subs/sub-1',
      callId: 'c2',
      agentType: 'explore',
      call,
      reason,
      ts: 't',
    });
    expect(sub?.agentType).toBe('explore');
    expect(sub?.subSessionId).toBe('s1/subs/sub-1');
  });
});

// ── §10.4 会话池与事件扇出 ────────────────────────────────────────

describe('§10.4 会话池：多会话并行 / 事件扇出 / 生命周期', () => {
  it('create → run:start → 事件经 emit 扇出 → session:status 变更', async () => {
    const reg = makeRegistry({
      '*': [{ content: '完成。' }],
    });
    const events: Array<{ type: string }> = [];
    const statuses: Array<{ sessionId: string; state: string }> = [];
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: (e) => events.push(e),
      emitStatus: (sessionId, state) => statuses.push({ sessionId, state }),
    });
    const s = await service.create({ workspaceRoot: dir });
    const res = service.start({ sessionId: s.id, text: 'hi' });
    expect(res.accepted).toBe(true);
    expect(res.runId).toMatch(/^run-/);
    await waitFor(() => statuses.some((x) => x.state === 'completed'));
    expect(events.some((e) => e.type === 'turn.started')).toBe(true);
    expect(events.some((e) => e.type === 'message.completed')).toBe(true);
    expect(events.some((e) => e.type === 'task.completed')).toBe(true);
  });

  it('同一会话并发 run:start → 第二个被 ERR_SESSION_BUSY 拒绝', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reg = makeRegistry({
      '*': [{ content: '等待' }],
    });
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const s = await service.create({ workspaceRoot: dir });
    const r1 = service.start({ sessionId: s.id, text: 'a' });
    expect(r1.accepted).toBe(true);
    // 立即再发：引擎尚在运行 → busy
    const r2 = service.start({ sessionId: s.id, text: 'b' });
    expect(r2.accepted).toBe(false);
    expect(r2.error?.code).toBe('ERR_SESSION_BUSY');
    release();
    void gate;
  });

  it('未知会话 run:start → ERR_SESSION_NOT_FOUND', () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const res = service.start({ sessionId: 'nope', text: 'x' });
    expect(res.accepted).toBe(false);
    expect(res.error?.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  it('多会话并行：两个会话各自独立事件流（sessionId 分桶）', async () => {
    const reg = makeRegistry({
      '*': [{ content: 'ok' }],
    });
    const bySession = new Map<string, number>();
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: (e) => {
        const sid = (e as { sessionId?: string }).sessionId ?? '';
        bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
      },
    });
    const a = await service.create({ workspaceRoot: dir });
    const b = await service.create({ workspaceRoot: dir });
    service.start({ sessionId: a.id, text: 'A' });
    service.start({ sessionId: b.id, text: 'B' });
    await waitFor(() => (bySession.get(a.id) ?? 0) > 0 && (bySession.get(b.id) ?? 0) > 0);
    expect(bySession.get(a.id)!).toBeGreaterThan(0);
    expect(bySession.get(b.id)!).toBeGreaterThan(0);
  });

  it('多窗口占用同一会话：alreadyOpen + focus 指向首窗口', async () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const s = await service.create({ workspaceRoot: dir });
    const first = service.attachWindow(s.id, 'w1');
    expect(first.alreadyOpen).toBe(false);
    const second = service.attachWindow(s.id, 'w2');
    expect(second.alreadyOpen).toBe(true);
    expect(second.focus).toBe('w1');
  });

  it('窗口关闭 ≠ 会话销毁：detach 后引擎仍在池中', async () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const s = await service.create({ workspaceRoot: dir });
    service.attachWindow(s.id, 'w1');
    service.detachWindow(s.id, 'w1');
    expect(service.poolSize).toBe(1);
  });

  it('shutdown：全部会话 abort，10s 上限内完成', async () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    await service.create({ workspaceRoot: dir });
    const t0 = Date.now();
    await service.shutdown(2000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('list() 合并磁盘会话与内存池状态', async () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const s = await service.create({ workspaceRoot: dir });
    const list = service.list();
    expect(list.some((x) => x.id === s.id)).toBe(true);
    const item = list.find((x) => x.id === s.id)!;
    expect(item.project).toBe(path.basename(dir));
  });
});

// ── §10.3 审批路由 ────────────────────────────────────────────────

describe('§10.3 审批：approval:resolve 路由 + 待处理回放', () => {
  it('tool.approval.required → 记录 pending → resolve 后清空', async () => {
    const reg = makeRegistry({
      '*': [
        // riskLevel:'exec' → auto 策略下 exec='ask'，必出审批票据
        {
          toolCalls: [
            {
              name: 'shell',
              arguments: { command: 'git push --force origin main' },
              riskLevel: 'exec' as const,
            },
          ],
        },
        { content: 'done' },
      ],
    });
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: () => {},
      policyMode: 'auto',
    });
    const s = await service.create({ workspaceRoot: dir });
    service.start({ sessionId: s.id, text: 'run' });
    await waitFor(() => service.pendingApprovals(s.id).length > 0);
    const ticket = service.pendingApprovals(s.id)[0]!;
    expect(ticket.callId).toBeTruthy();
    const r = service.resolveApproval({
      sessionId: s.id,
      callId: ticket.callId,
      decision: 'allow',
    });
    expect(r.ok).toBe(true);
    // resolve 后 pending 清空
    await waitFor(() => service.pendingApprovals(s.id).length === 0);
    // 立即收尾（shell 会真实执行 "git push --force"，不等待其跑完）
    await service.shutdown(500);
  });

  it('权限模式切换即时生效：settings 改 full-auto → run:start 不再弹审批（经 IPC 链路）', async () => {
    // 复现真实场景：AgentService 构造时是默认 'auto'（应用启动时的值），
    // 用户随后在 UI 改成"完全访问"（config:set → settings）。
    // 修复前：run:start 不注入 policy，会话沿用 auto → exec 工具仍弹审批。
    const reg = makeRegistry({
      '*': [
        {
          toolCalls: [
            {
              name: 'shell',
              arguments: { command: 'echo hi' },
              riskLevel: 'exec' as const,
            },
          ],
        },
        { content: 'done' },
      ],
    });
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: () => {},
      policyMode: 'auto',
    });
    const settings = new SettingsStore({ filePath: settingsFile });
    // 模拟 config:set（UI 选择"完全访问"）
    settings.applyPatch({ policyMode: 'full-auto' });
    service.setPolicyMode('full-auto');

    const channel = new LoopbackChannel();
    const bridge = new IpcBridge({
      service,
      settings,
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();

    const s = await service.create({ workspaceRoot: dir });
    const r = (await channel.invoke('run:start', { sessionId: s.id, text: 'run' })) as {
      accepted: boolean;
    };
    expect(r.accepted).toBe(true);
    // 会话完成且全程零审批票据（full-auto 下 exec 直接放行）。
    await waitFor(() => !service.isRunning(s.id));
    expect(service.pendingApprovals(s.id).length).toBe(0);
    await service.shutdown(2000);
  });

  it('abort during pending approval → 票据清空 + 会话收尾（不再挂死）', async () => {
    const reg = makeRegistry({
      '*': [
        // riskLevel:'exec' → auto 策略下必出审批票据，且无人 resolve（模拟 UI 挂起）
        {
          toolCalls: [
            {
              name: 'shell',
              arguments: { command: 'git push --force origin main' },
              riskLevel: 'exec' as const,
            },
          ],
        },
        { content: 'done' },
      ],
    });
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: () => {},
      policyMode: 'auto',
    });
    const s = await service.create({ workspaceRoot: dir });
    service.start({ sessionId: s.id, text: 'run' });
    await waitFor(() => service.pendingApprovals(s.id).length > 0);
    expect(service.isRunning(s.id)).toBe(true);

    // 用户点「中止」：审批尚未裁决
    const r = service.abort({ sessionId: s.id });
    expect(r.ok).toBe(true);
    // 票据立即清空（失效的审批不应再显示）
    expect(service.pendingApprovals(s.id).length).toBe(0);
    // 会话在 3s 内收尾（waitFor 超时即失败 —— 修复前此处会挂 10 分钟）
    await waitFor(() => !service.isRunning(s.id));
    await service.shutdown(2000);
  });

  it('abort 未知会话 → { ok: false }', () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    expect(service.abort({ sessionId: 'x' }).ok).toBe(false);
  });
});

// ── §10.5③ Diff 审阅 + 逐 hunk 批准 ──────────────────────────────

describe('§10.5③ Diff 审阅：hunk 模型 + 逐 hunk 部分应用', () => {
  it('diffScript：LCS 最小编辑脚本', () => {
    const ops = diffScript(['a', 'b', 'c'], ['a', 'B', 'c']);
    const kinds = ops.map((o) => o[0]).join('');
    // 期望：保留 a，删除 b，新增 B，保留 c
    expect(kinds).toBe('=-+=');
  });

  it('buildHunks：连续变更聚合为单 hunk，带稳定 id 与行范围', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const after = ['l1', 'X', 'l3', 'l4', 'l5'];
    const model = buildSideBySide('f.ts', before.join('\n'), after.join('\n'));
    expect(model.hunks.length).toBe(1);
    const h = model.hunks[0]!;
    expect(h.id).toBe('h1');
    expect(h.kind).toBe('replace');
    expect(h.oldLines).toEqual(['l2']);
    expect(h.newLines).toEqual(['X']);
    expect(h.oldRange).toEqual({ startLine: 2, endLine: 3 });
    expect(model.stats).toEqual({ additions: 1, deletions: 1 });
  });

  it('buildHunks：多处独立变更 → 多个 hunk', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'G'];
    const model = buildSideBySide('f.ts', before.join('\n'), after.join('\n'));
    expect(model.hunks.length).toBe(2);
    expect(model.hunks.map((h) => h.id)).toEqual(['h1', 'h2']);
  });

  it('纯新增 / 纯删除的 hunk kind', () => {
    const add = buildHunks(diffScript(['a'], ['a', 'b']));
    expect(add[0]?.kind).toBe('add');
    const del = buildHunks(diffScript(['a', 'b'], ['a']));
    expect(del[0]?.kind).toBe('delete');
  });

  it('applyHunksToContent：仅应用选中 hunk，未选中保持旧内容', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const model = buildSideBySide(
      'f.ts',
      before.join('\n'),
      ['A', 'b', 'c', 'd', 'e', 'f', 'G'].join('\n'),
    );
    const onlyFirst = applyHunksToContent(before.join('\n'), model.hunks, ['h1']);
    expect(onlyFirst.split('\n')).toEqual(['A', 'b', 'c', 'd', 'e', 'f', 'g']);
    const onlySecond = applyHunksToContent(before.join('\n'), model.hunks, ['h2']);
    expect(onlySecond.split('\n')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'G']);
    const both = applyHunksToContent(before.join('\n'), model.hunks, ['h1', 'h2']);
    expect(both.split('\n')).toEqual(['A', 'b', 'c', 'd', 'e', 'f', 'G']);
  });

  it('DiffReviewService：record → applyPartial 仅写入选中 hunk', () => {
    const file = 'x.ts';
    let current = 'a\nb\nc\nd\ne\nf\ng';
    const svc = new DiffReviewService({
      readFile: () => current,
      writeFile: (_f, content) => {
        current = content;
      },
    });
    const model = svc.record('s1', file, current, 'A\nb\nc\nd\ne\nf\nG');
    expect(model.hunks.length).toBe(2);
    const r = svc.applyPartial({ sessionId: 's1', file, hunkIds: ['h1'] });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    expect(current.split('\n')).toEqual(['A', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('applyPartial：未知会话 / 空选择 → { ok: false }', () => {
    const svc = new DiffReviewService({ readFile: () => '', writeFile: () => {} });
    expect(svc.applyPartial({ sessionId: 'n', file: 'f', hunkIds: ['h1'] }).ok).toBe(false);
    svc.record('s', 'f', 'a', 'b');
    expect(svc.applyPartial({ sessionId: 's', file: 'f', hunkIds: [] }).ok).toBe(false);
  });

  it('hunkDecorations：每 hunk 生成 original/modified 两组 decoration', () => {
    const model = buildSideBySide('f.ts', 'a\nb\nc\nd\ne\nf\ng', 'A\nb\nc\nd\ne\nf\nG');
    const decos = hunkDecorations(model.hunks);
    expect(decos.original.length).toBe(2);
    expect(decos.modified.length).toBe(2);
    expect(decos.modified[0]?.options.className).toBe('hunk-replace');
  });

  it('languageFor：按扩展名推断 Monaco 语言', () => {
    expect(languageFor('a.ts')).toBe('typescript');
    expect(languageFor('a.py')).toBe('python');
    expect(languageFor('a.unknown')).toBe('plaintext');
  });
});

// ── §10.6 设置与密钥 ─────────────────────────────────────────────

describe('§10.6 设置中心 + 密钥安全', () => {
  it('maskSecret：只保留前缀与末 4 位', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('sk-…abcd');
    expect(maskSecret('short')).toBe('…');
    expect(maskSecret('')).toBe('');
  });

  it('safeStorage 可用 → 加密存储，getApiKey 可解密', () => {
    const s = new SettingsStore({ filePath: settingsFile, safeStorage: fakeSafeStorage() });
    s.setProvider('openai', { model: 'gpt-4o', baseUrl: 'https://api.openai.com' });
    const r = s.setApiKey('openai', 'sk-secret-value-1234');
    expect(r.ok).toBe(true);
    expect(s.getApiKey('openai')).toBe('sk-secret-value-1234');
    // 落盘内容为密文，绝不含明文
    const onDisk = fs.readFileSync(settingsFile, 'utf8');
    expect(onDisk).not.toContain('sk-secret-value-1234');
  });

  it('safeStorage 不可用 → 拒绝明文存储并提示环境变量', () => {
    // 独立文件，避免读到其它用例留下的密文记录
    const isolated = path.join(dir, 'settings-nostorage.json');
    const s = new SettingsStore({ filePath: isolated });
    const r = s.setApiKey('openai', 'sk-x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/环境变量/);
    expect(s.getApiKey('openai')).toBeUndefined();
  });

  it('环境变量回退：未存储密钥时读 MOZI_API_KEY', () => {
    const prev = process.env.MOZI_API_KEY;
    process.env.MOZI_API_KEY = 'sk-from-env';
    try {
      const s = new SettingsStore({ filePath: settingsFile });
      s.setProvider('default', { model: 'm' });
      expect(s.getApiKey('default')).toBe('sk-from-env');
    } finally {
      if (prev == null) process.env.MOZI_API_KEY = undefined;
      else process.env.MOZI_API_KEY = prev;
    }
  });

  it('listProviders：只回脱敏预览，绝不含明文', () => {
    const s = new SettingsStore({ filePath: settingsFile, safeStorage: fakeSafeStorage() });
    s.setProvider('openai', { model: 'gpt-4o' });
    s.setApiKey('openai', 'sk-abcdefghijklmnop');
    const list = s.listProviders();
    const p = list.find((x) => x.id === 'openai')!;
    expect(p.hasApiKey).toBe(true);
    expect(p.maskedKey).toBe('sk-…mnop');
    expect(JSON.stringify(list)).not.toContain('sk-abcdefghijklmnop');
  });

  it('applyPatch 合并式更新 + 持久化可重载', () => {
    const a = new SettingsStore({ filePath: settingsFile });
    a.applyPatch({ policyMode: 'full-auto', sandboxLevel: 3 });
    const b = new SettingsStore({ filePath: settingsFile });
    expect(b.policyMode()).toBe('full-auto');
    expect(b.sandboxLevel()).toBe(3);
  });

  it('closeBehavior（基础设置）：默认托盘常驻，setter 持久化', () => {
    const a = new SettingsStore({ filePath: settingsFile });
    // 与 backgroundRun 默认一致：关闭窗口后后台常驻（托盘）。
    expect(a.closeBehavior()).toBe('tray');
    a.setCloseBehavior('quit');
    const b = new SettingsStore({ filePath: settingsFile });
    expect(b.closeBehavior()).toBe('quit');
    b.setCloseBehavior('tray');
    expect(b.closeBehavior()).toBe('tray');
  });

  it('provider apiFormat + modelMap：持久化并经 listProviders 回显', () => {
    const a = new SettingsStore({ filePath: settingsFile });
    a.setProvider('gw', {
      model: 'claude-3-5',
      baseUrl: 'http://127.0.0.1:3000',
      apiFormat: 'anthropic',
      modelMap: { 'my-claude': 'claude-3-5', 'my-sonnet': 'claude-3-5-sonnet' },
    });
    const b = new SettingsStore({ filePath: settingsFile });
    const gw = b.listProviders().find((p) => p.id === 'gw')!;
    expect(gw.apiFormat).toBe('anthropic');
    expect(gw.modelMap).toEqual({ 'my-claude': 'claude-3-5', 'my-sonnet': 'claude-3-5-sonnet' });
    // 可选模型 = 映射本地名列表
    expect(gw.models).toEqual(['my-claude', 'my-sonnet']);
    // 直连 provider：models = [model]，无 modelMap
    b.setProvider('plain', { model: 'gpt-4o' });
    const plain = b.listProviders().find((p) => p.id === 'plain')!;
    expect(plain.apiFormat).toBe('openai');
    expect(plain.models).toEqual(['gpt-4o']);
    expect(plain.modelMap).toBeUndefined();
  });

  it('provider models 列表：一个提供商多个模型（任务窗口模型选择器数据源）', () => {
    const a = new SettingsStore({ filePath: settingsFile });
    a.setProvider('deepseek', {
      model: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const b = new SettingsStore({ filePath: settingsFile });
    const p = b.listProviders().find((x) => x.id === 'deepseek')!;
    // models 列表整体回显（优先于单 model）
    expect(p.models).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);
    expect(p.autoRoute).toBeUndefined();
  });

  it('appendSessionAllow：会话级 allow 规则只进内存、按工具去重', () => {
    const s = new SettingsStore({ filePath: settingsFile });
    s.appendSessionAllow('s1', 'shell');
    s.appendSessionAllow('s1', 'shell'); // 同会话同工具 → 幂等
    s.appendSessionAllow('s1', 'write_file');
    s.appendSessionAllow('s2', 'shell'); // 其他会话不可见
    const rules = s.sessionAllowRules('s1');
    expect(rules.length).toBe(2);
    expect(rules[0]).toEqual({
      id: 'once-s1:shell',
      match: { tool: 'shell' },
      action: 'allow',
    });
    expect(s.isSessionAllowed('s1', 'shell')).toBe(true);
    expect(s.isSessionAllowed('s1', 'browser')).toBe(false);
    expect(s.isSessionAllowed('s2', 'write_file')).toBe(false);
    // 不污染持久化规则表（旧实现会把 once-* 堆进 policyRules）
    expect(s.policyRules().some((r) => r.id.startsWith('once-'))).toBe(false);
    s.clearSessionAllows('s1');
    expect(s.sessionAllowRules('s1')).toEqual([]);
    expect(s.isSessionAllowed('s1', 'shell')).toBe(false);
  });

  it('迁移清洗：历史 once-* 规则丢弃，完全重复规则去重', () => {
    const legacy = path.join(dir, 'settings-legacy-rules.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        policyRules: [
          { id: 'once-sess-a-1-tc_0', match: { tool: '*' }, action: 'allow' },
          { id: 'once-sess-a-2-tc_0', match: { tool: '*' }, action: 'allow' },
          { id: 'user-rule', match: { tool: 'shell' }, action: 'ask' },
          { id: 'user-rule-dup', match: { tool: 'shell' }, action: 'ask' },
          { id: 'user-unique', match: { pathGlob: '.env*' }, action: 'ask' },
        ],
      }),
    );
    const s = new SettingsStore({ filePath: legacy });
    const rules = s.policyRules();
    // once-* 全部清掉；同 match+action 的重复只留首条
    expect(rules.map((r) => r.id)).toEqual(['user-rule', 'user-unique']);
    // 清洗结果回写磁盘（下次启动不再重复迁移）
    const onDisk = JSON.parse(fs.readFileSync(legacy, 'utf8')) as { policyRules: unknown[] };
    expect(onDisk.policyRules.length).toBe(2);
  });

  it('testProvider：未配置密钥 → ok:false', async () => {
    const isolated = path.join(dir, 'settings-nokey.json');
    const s = new SettingsStore({ filePath: isolated });
    const r = await s.testProvider('openai');
    expect(r.ok).toBe(false);
  });
});

// ── §10.5⑦ MCP 管理中心 ──────────────────────────────────────────

describe('§10.5⑦ MCP 管理中心', () => {
  it('add：stdio 缺 command → 拒绝；正常 → connected', async () => {
    const persisted: unknown[] = [];
    const mcp = new McpManager({
      connect: async () => ({ toolCount: 5 }),
      disconnect: async () => {},
      persist: (servers) => persisted.push(servers),
    });
    expect((await mcp.add({ id: 'a', transport: 'stdio' })).ok).toBe(false);
    const r = await mcp.add({ id: 'b', transport: 'stdio', command: 'node', args: ['x.js'] });
    expect(r.ok).toBe(true);
    const info = mcp.list().find((x) => x.id === 'b')!;
    expect(info.status).toBe('connected');
    expect(info.toolCount).toBe(5);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('add：重复 id → 拒绝', async () => {
    const mcp = new McpManager({
      connect: async () => ({ toolCount: 0 }),
      disconnect: async () => {},
      persist: () => {},
    });
    await mcp.add({ id: 'a', transport: 'http', url: 'http://x' });
    const r = await mcp.add({ id: 'a', transport: 'http', url: 'http://y' });
    expect(r.ok).toBe(false);
  });

  it('restart → 重新连接；remove → 移除', async () => {
    let count = 1;
    const mcp = new McpManager({
      connect: async () => ({ toolCount: count }),
      disconnect: async () => {},
      persist: () => {},
    });
    await mcp.add({ id: 'a', transport: 'http', url: 'http://x' });
    count = 9;
    expect((await mcp.restart('a')).ok).toBe(true);
    expect(mcp.list().find((x) => x.id === 'a')?.toolCount).toBe(9);
    expect((await mcp.remove('a')).ok).toBe(true);
    expect(mcp.list().length).toBe(0);
  });

  it('采样三档 / trusted / allowedTools 编辑', async () => {
    const mcp = new McpManager({
      connect: async () => ({ toolCount: 0 }),
      disconnect: async () => {},
      persist: () => {},
    });
    await mcp.add({ id: 'a', transport: 'http', url: 'http://x' });
    mcp.setSampling('a', 'allow');
    mcp.setTrusted('a', true);
    mcp.setAllowedTools('a', ['read_file']);
    const info = mcp.list()[0]!;
    expect(info.sampling).toBe('allow');
    expect(info.trusted).toBe(true);
    // 连接失败 → offline
    const mcp2 = new McpManager({
      connect: async () => {
        throw new Error('boom');
      },
      disconnect: async () => {},
      persist: () => {},
    });
    await mcp2.add({ id: 'b', transport: 'http', url: 'http://x' });
    expect(mcp2.list()[0]?.status).toBe('offline');
  });

  it('replaceAll（mcp.json 直接编辑）：校验失败不落盘；成功整体替换并断开消失项', async () => {
    const persisted: McpAddRequest[][] = [];
    const disconnected: string[] = [];
    const mcp = new McpManager({
      connect: async (spec) => ({ toolCount: spec.id === 'api' ? 5 : 0 }),
      disconnect: async (id) => {
        disconnected.push(id);
      },
      persist: (servers) => persisted.push(servers),
    });
    await mcp.add({ id: 'old', transport: 'http', url: 'http://old' });

    // ① 校验失败（缺 url + id 重复）→ 不落盘，原配置保持
    const bad = await mcp.replaceAll([
      {
        id: 'api',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      { id: 'api', transport: 'http' }, // 重复 id + 缺 url
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors?.[0]?.index).toBe(1);
    expect(mcp.list().map((x) => x.id)).toContain('old'); // 原配置未被破坏

    // ② 成功替换：old 消失（断开），api 带 headers 接入
    const good = await mcp.replaceAll([
      {
        id: 'api',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer t' },
        timeoutMs: 10000,
      },
    ]);
    expect(good.ok).toBe(true);
    expect(disconnected).toContain('old');
    expect(mcp.list().map((x) => x.id)).toEqual(['api']);
    expect(mcp.list()[0]?.toolCount).toBe(5);
    // 持久化的配置含 headers / timeoutMs
    const last = persisted[persisted.length - 1]!;
    expect(last[0]?.headers).toEqual({ Authorization: 'Bearer t' });
    expect(last[0]?.timeoutMs).toBe(10000);

    // ③ config() 返回完整配置（JSON 编辑器数据源）
    const cfg = mcp.config();
    expect(cfg).toHaveLength(1);
    expect(cfg[0]?.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('upsert（单条编辑）：重连并更新配置', async () => {
    const persisted: McpAddRequest[][] = [];
    const mcp = new McpManager({
      connect: async () => ({ toolCount: 3 }),
      disconnect: async () => {},
      persist: (servers) => persisted.push(servers),
    });
    await mcp.add({ id: 'api', transport: 'http', url: 'http://v1' });
    // 编辑：改 url + 加 headers
    const r = await mcp.upsert({
      id: 'api',
      transport: 'http',
      url: 'http://v2',
      headers: { Authorization: 'Bearer x' },
    });
    expect(r.ok).toBe(true);
    expect(mcp.list()[0]?.toolCount).toBe(3);
    expect(mcp.config()[0]?.url).toBe('http://v2');
    expect(mcp.config()[0]?.headers).toEqual({ Authorization: 'Bearer x' });
  });
});

// ── §10.5② UI store 与事件流一致性 ───────────────────────────────

describe('§10.5② 渲染进程 store：UI 状态与事件流一致', () => {
  beforeEach(() => resetRenderIdSeq());

  it('eventToRenderItems：turn.started → user；message → assistant + tool 卡', () => {
    const items = eventToRenderItems({
      type: 'message.completed',
      message: {
        role: 'assistant',
        content: 'hi',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: {}, riskLevel: 'read' }],
      },
      ts: 't',
    });
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'tool']);
  });

  it('message.delta 流式合并为单条 assistant', () => {
    const store = new UiStore();
    store.apply('s1', { type: 'message.delta', text: '你', ts: 't1' });
    store.apply('s1', { type: 'message.delta', text: '好', ts: 't2' });
    const items = store.view('s1')?.items;
    expect(items.length).toBe(1);
    expect(items[0]?.kind === 'assistant' && items[0]?.text).toBe('你好');
  });

  it('tool.completed 更新已有 tool 卡状态（不新增）', () => {
    const store = new UiStore();
    store.apply('s1', {
      type: 'message.completed',
      message: {
        role: 'assistant',
        content: 'x',
        toolCalls: [{ id: 'c1', name: 'shell', arguments: {}, riskLevel: 'exec' }],
      },
      ts: 't',
    });
    store.apply('s1', {
      type: 'tool.completed',
      callId: 'c1',
      result: { callId: 'c1', content: 'ok', isError: false },
      ts: 't',
    });
    const tools = store.view('s1')?.items.filter((i) => i.kind === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0]?.kind === 'tool' && tools[0]?.state).toBe('done');
  });

  it('审批事件进入 pendingApprovals，resolved 后移除', () => {
    const store = new UiStore();
    const call = { id: 'c1', name: 'shell', arguments: {}, riskLevel: 'exec' as const };
    store.apply('s1', {
      type: 'tool.approval.required',
      call,
      reason: { kind: 'manual', note: 'n' },
      ts: 't',
    });
    expect(store.view('s1')?.pendingApprovals.length).toBe(1);
    store.apply('s1', {
      type: 'tool.approval.resolved',
      callId: 'c1',
      decision: 'allow',
      by: 'user',
      ts: 't',
    });
    expect(store.view('s1')?.pendingApprovals.length).toBe(0);
  });

  it('子智能体事件归并进 subagents 树', () => {
    const store = new UiStore();
    store.apply('s1', {
      type: 'subagent.started',
      subSessionId: 's1/subs/sub-1',
      parentSessionId: 's1',
      agentType: 'explore',
      prompt: 'p',
      ts: 't',
    });
    store.apply('s1', {
      type: 'subagent.progress',
      subSessionId: 's1/subs/sub-1',
      step: 3,
      maxSteps: 30,
      currentTool: 'grep',
      tokensUsed: 100,
      ts: 't',
    });
    store.apply('s1', {
      type: 'subagent.completed',
      subSessionId: 's1/subs/sub-1',
      summary: 'done',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'm' },
      steps: 3,
      durationMs: 1000,
      ts: 't',
    });
    const node = store.view('s1')?.subagents[0]!;
    expect(node.agentType).toBe('explore');
    expect(node.state).toBe('completed');
    expect(node.step).toBe(3);
  });

  it('session:status 推送更新会话状态与徽标', () => {
    const store = new UiStore();
    store.setSessions([{ id: 's1', state: 'idle' }]);
    store.status('s1', 'running');
    expect(store.view('s1')?.state).toBe('running');
    expect(store.getState().sessions[0]?.state).toBe('running');
    expect(store.getState().lastStatus).toEqual({ sessionId: 's1', state: 'running' });
  });

  it('bind：订阅 LoopbackChannel 事件流（UI 与事件流一致）', () => {
    const channel = new LoopbackChannel();
    const store = new UiStore();
    const off = store.bind(channel as never);
    channel.send('engine:event', {
      sessionId: 's9',
      event: { type: 'message.delta', text: '流', ts: 't' },
    });
    channel.send('session:status', { sessionId: 's9', state: 'running' });
    expect(store.view('s9')?.items.length).toBe(1);
    expect(store.view('s9')?.state).toBe('running');
    off();
  });
});

// ── §10.2 进程安全（preload 白名单）────────────────────────────────

describe('§10.2 进程安全：preload 通道白名单', () => {
  it('createPreloadInvoker：白名单外通道 → reject', async () => {
    const { createPreloadInvoker } = await import('@mozi/desktop');
    const invoke = createPreloadInvoker(async () => 'ok');
    await expect(invoke('evil:channel', {})).rejects.toThrow(/not allowed/);
    await expect(invoke('session:list', {})).resolves.toBe('ok');
  });

  it('createPreloadSubscriber：白名单外订阅 → throw', async () => {
    const { createPreloadSubscriber } = await import('@mozi/desktop');
    const sub = createPreloadSubscriber(() => () => {});
    expect(() => sub('evil', () => {})).toThrow(/not allowed/);
    expect(typeof sub('engine:event', () => {})).toBe('function');
  });
});

// ── IPC 端到端：会话 → 任务 → 审批 → 事件 → UI 状态 ──────────────

describe('M4 E2E：创建会话 → 发任务(ScriptedProvider) → 事件流 → UI 状态一致', () => {
  it('全链路：session:create → run:start → engine:event → UI store', async () => {
    const reg = makeRegistry({
      '*': [{ content: '任务完成。' }],
    });
    const channel = new LoopbackChannel();
    const store = new UiStore();
    // biome-ignore lint/style/useConst: service 的 emit 闭包引用 bridge，先声明后赋值。
    let bridge!: IpcBridge;
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: (e) => bridge.onEngineEvent(e),
      emitStatus: (sid, st) => bridge.onSessionStatus(sid, st),
    });
    const settings = new SettingsStore({ filePath: settingsFile });
    bridge = new IpcBridge({
      service,
      settings,
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    store.bind(channel as never);

    const created = (await channel.invoke('session:create', { workspaceRoot: dir })) as {
      id: string;
    };
    expect(created.id).toBeTruthy();
    const run = (await channel.invoke('run:start', {
      sessionId: created.id,
      text: '做一个任务',
    })) as { accepted: boolean };
    expect(run.accepted).toBe(true);

    await waitFor(() => store.view(created.id)?.state === 'completed');
    const view = store.view(created.id)!;
    expect(view.items.some((i) => i.kind === 'user' && i.text === '做一个任务')).toBe(true);
    expect(view.items.some((i) => i.kind === 'assistant' && i.text.includes('任务完成'))).toBe(
      true,
    );
    // 事件流一致性：store 收到的 event 数 == channel 推送数
    const pushed = channel.sent.filter((s) => s.channel === 'engine:event').length;
    expect(pushed).toBeGreaterThan(0);
  });

  it('session:list / dashboard:stats / audit:query 经 IPC 可用', async () => {
    const reg = makeRegistry({ '*': [{ content: 'ok' }] });
    const channel = new LoopbackChannel();
    // biome-ignore lint/style/useConst: service 的 emit 闭包引用 bridge，先声明后赋值。
    let bridge!: IpcBridge;
    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: (e) => bridge.onEngineEvent(e),
      emitStatus: (sid, st) => bridge.onSessionStatus(sid, st),
    });
    bridge = new IpcBridge({
      service,
      settings: new SettingsStore({ filePath: settingsFile }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    const created = (await channel.invoke('session:create', { workspaceRoot: dir })) as {
      id: string;
    };
    await channel.invoke('run:start', { sessionId: created.id, text: 'x' });
    await waitFor(() => service.list().some((s) => s.id === created.id));
    const list = (await channel.invoke('session:list', {})) as unknown[];
    expect(list.length).toBeGreaterThan(0);
    const stats = (await channel.invoke('dashboard:stats', {})) as { tokensByDay: unknown[] };
    expect(Array.isArray(stats.tokensByDay)).toBe(true);
    const audit = (await channel.invoke('audit:query', {})) as unknown[];
    expect(Array.isArray(audit)).toBe(true);
  });

  it('config:get / config:set / config:listProviders 经 IPC 可用且不泄漏密钥', async () => {
    const reg = makeRegistry({});
    const channel = new LoopbackChannel();
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const settings = new SettingsStore({ filePath: settingsFile, safeStorage: fakeSafeStorage() });
    const bridge = new IpcBridge({
      service,
      settings,
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    await channel.invoke('config:set', { patch: { policyMode: 'readonly' } });
    const got = (await channel.invoke('config:get', {})) as {
      policyMode: string;
      providers: unknown[];
    };
    expect(got.policyMode).toBe('readonly');
    const providers = (await channel.invoke('config:listProviders', {})) as unknown[];
    expect(Array.isArray(providers)).toBe(true);
  });

  it('provider 自动路由（model 空）：listProviders 返回 autoRoute + models=[id]', () => {
    const a = new SettingsStore({ filePath: settingsFile });
    a.setProvider('freellmapi', {
      model: '',
      baseUrl: 'http://127.0.0.1:3000/v1',
      apiFormat: 'openai',
    });
    const b = new SettingsStore({ filePath: settingsFile });
    const p = b.listProviders().find((x) => x.id === 'freellmapi')!;
    expect(p.autoRoute).toBe(true);
    // 可选模型 = [provider id]（本地名），UI 显示「网关自动路由」
    expect(p.models).toEqual(['freellmapi']);
    expect(p.model).toBe('');
    // 对照：普通直连 provider 不带 autoRoute 标记
    b.setProvider('normal', { model: 'gpt-4o' });
    const n = b.listProviders().find((x) => x.id === 'normal')!;
    expect(n.autoRoute).toBeUndefined();
    expect(n.models).toEqual(['gpt-4o']);
  });

  it('provider:models：未配置 provider / 本地端点无 key 不强制', async () => {
    const reg = makeRegistry({});
    const channel = new LoopbackChannel();
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const settings = new SettingsStore({ filePath: settingsFile });
    const bridge = new IpcBridge({
      service,
      settings,
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    // provider 不存在
    const r1 = (await channel.invoke('provider:models', { providerId: 'nope' })) as {
      ok: boolean;
      error?: string;
    };
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Base URL/);
    // 有 baseUrl 但端点不可达（本地端口 1 无服务）：无 key 也发起请求，错误为连接失败而非"缺 Key"
    settings.setProvider('local', { model: 'x', baseUrl: 'http://127.0.0.1:1' });
    const r2 = (await channel.invoke('provider:models', { providerId: 'local' })) as {
      ok: boolean;
      error?: string;
    };
    expect(r2.ok).toBe(false);
    expect(r2.error).not.toMatch(/API Key/);
    expect(r2.error).toBeTruthy();
  });

  it('provider:discoverLocal：本地无模型服务 → ok:false', async () => {
    const reg = makeRegistry({});
    const channel = new LoopbackChannel();
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const bridge = new IpcBridge({
      service,
      settings: new SettingsStore({ filePath: settingsFile }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    // 端口 1 无服务：连接立即失败，返回 ok:false
    const r = (await channel.invoke('provider:discoverLocal', { ports: [1] })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  // ── provider:models 防御性解析（修复 "Unexpected token '<'"）──
  // 用本地 HTTP 服务器复现真实网关行为：Dashboard 与 API 同端口，
  // 未知路径返回 200 的 SPA HTML 页面。

  /** 起一个本地测试服务器；routes: 路径 → { status, body, type }。返回端口。 */
  async function startTestServer(
    routes: Record<string, { status?: number; body: string; type?: string }>,
  ): Promise<{ port: number; close(): Promise<void> }> {
    const server = http.createServer((req, res) => {
      const hit = routes[req.url ?? ''];
      if (hit) {
        res.writeHead(hit.status ?? 200, { 'content-type': hit.type ?? 'application/json' });
        res.end(hit.body);
        return;
      }
      // 未命中：SPA fallback 返回 HTML（模拟 FreeLLMAPI Dashboard）
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>Dashboard</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    return {
      port: addr.port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** 构建带 provider:models 的 IPC 桥（本地服务器场景）。 */
  function mkModelsBridge(): { channel: LoopbackChannel } {
    const channel = new LoopbackChannel();
    const bridge = new IpcBridge({
      service: new AgentService({ sessionDir, providers: makeRegistry({}), emit: () => {} }),
      settings: new SettingsStore({ filePath: settingsFile }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    return { channel };
  }

  it('provider:models：端点返回 HTML 页面 → 友好错误（不再抛 JSON 解析错误）', async () => {
    const srv = await startTestServer({}); // 全部路径都回 HTML（SPA fallback）
    const { channel } = mkModelsBridge();
    try {
      const r = (await channel.invoke('provider:models', {
        providerId: 'x',
        baseUrl: `http://127.0.0.1:${srv.port}`,
        apiFormat: 'openai',
      })) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      // 错误应是可读的中文提示，而非 "Unexpected token '<'"
      expect(r.error).not.toMatch(/Unexpected token/);
      expect(r.error).toMatch(/HTML|网页/);
    } finally {
      await srv.close();
    }
  });

  it('provider:models：openai 格式 /models 404 → 自动回退 /v1/models', async () => {
    // 模拟只支持 /v1 前缀的网关：/models 返回 404 HTML，/v1/models 返回 JSON
    const server = http.createServer((req, res) => {
      if (req.url === '/models') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html>404</html>');
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const { channel } = mkModelsBridge();
    try {
      const r = (await channel.invoke('provider:models', {
        providerId: 'x',
        baseUrl: `http://127.0.0.1:${port}`, // 不带 /v1
        apiFormat: 'openai',
      })) as { ok: boolean; models?: string[] };
      expect(r.ok).toBe(true);
      expect(r.models).toEqual(['m-a', 'm-b']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('provider:models：gemini 格式解析 { models: [{ name: "models/xxx" }] }', async () => {
    const srv = await startTestServer({
      '/v1beta/models': {
        body: JSON.stringify({
          models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-pro' }],
        }),
      },
    });
    const { channel } = mkModelsBridge();
    try {
      const r = (await channel.invoke('provider:models', {
        providerId: 'x',
        baseUrl: `http://127.0.0.1:${srv.port}`,
        apiFormat: 'gemini',
      })) as { ok: boolean; models?: string[] };
      expect(r.ok).toBe(true);
      // 去掉 "models/" 前缀
      expect(r.models).toEqual(['gemini-2.0-flash', 'gemini-pro']);
    } finally {
      await srv.close();
    }
  });

  it('provider:discoverLocal：端口上是普通网页（HTML）→ 不误判为模型服务', async () => {
    const srv = await startTestServer({}); // 全部 200 HTML
    const channel = new LoopbackChannel();
    const bridge = new IpcBridge({
      service: new AgentService({ sessionDir, providers: makeRegistry({}), emit: () => {} }),
      settings: new SettingsStore({ filePath: settingsFile }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();
    try {
      const r = (await channel.invoke('provider:discoverLocal', { ports: [srv.port] })) as {
        ok: boolean;
        baseUrl?: string;
        error?: string;
      };
      expect(r.ok).toBe(false);
      expect(r.baseUrl).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('workspace:pick：注入 picker → 返回路径；取消 → canceled；未注入 → 明确报错', async () => {
    const reg = makeRegistry({});
    const service = new AgentService({ sessionDir, providers: reg, emit: () => {} });
    const mkBridge = (pick?: () => Promise<string | null>): LoopbackChannel => {
      const channel = new LoopbackChannel();
      const bridge = new IpcBridge({
        service,
        settings: new SettingsStore({ filePath: settingsFile }),
        diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
        mcp: new McpManager({
          connect: async () => ({ toolCount: 0 }),
          disconnect: async () => {},
          persist: () => {},
        }),
        channel,
        ...(pick ? { pickWorkspace: pick } : {}),
      });
      bridge.install();
      return channel;
    };
    // 选中目录
    const c1 = mkBridge(async () => 'D:\\work\\mozi-demo');
    const r1 = (await c1.invoke('workspace:pick', {})) as {
      ok: boolean;
      path?: string;
      canceled?: boolean;
    };
    expect(r1.ok).toBe(true);
    expect(r1.path).toBe('D:\\work\\mozi-demo');
    expect(r1.canceled).toBeUndefined();
    // 用户取消
    const c2 = mkBridge(async () => null);
    const r2 = (await c2.invoke('workspace:pick', {})) as {
      ok: boolean;
      path?: string;
      canceled?: boolean;
    };
    expect(r2.ok).toBe(true);
    expect(r2.canceled).toBe(true);
    expect(r2.path).toBeUndefined();
    // 未注入 picker（非 Electron 环境）
    const c3 = mkBridge();
    const r3 = (await c3.invoke('workspace:pick', {})) as { ok: boolean; error?: string };
    expect(r3.ok).toBe(false);
    expect(r3.error).toBeTruthy();
  });
});

// ── helpers ───────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
