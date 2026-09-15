import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentService,
  BrowserRegistry,
  BrowserService,
  type BrowserWebContentsLike,
} from '@mozi/desktop';
import { LoopbackChannel } from '@mozi/protocol';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 任务浏览器面板测试：
 *   - BrowserService attach 模式：navigate/screenshot 路由到接管 webContents；close 不销毁
 *   - 未打开浏览器时：browser 工具给出「打开浏览器面板」的明确错误
 *   - BrowserRegistry：attach/detach/for/dispose；webContents 不存在报错
 *   - 端到端：agent 的 browser 工具经 browserFor 注入，操作用户打开的同一 webview
 */

/** 假 webview 的 guest webContents（记录调用）。 */
class FakeWebContents implements BrowserWebContentsLike {
  loadedUrls: string[] = [];
  closed = false;
  private currentUrl = '';
  private title = '页面标题';

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.currentUrl = url;
  }
  getURL(): string {
    return this.currentUrl;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return false;
  }
  async capturePage(): Promise<{
    toDataURL(): string;
    toPNG(): Buffer;
    getSize(): () => { width: number; height: number };
  }> {
    return {
      toDataURL: () => 'data:image/png;base64,ZmFrZQ==',
      toPNG: () => Buffer.from('fake'),
      getSize: () => ({ width: 640, height: 480 }),
    };
  }
  async executeJavaScript(script: string): Promise<unknown> {
    if (script.includes('document.body.innerText')) return '页面文本';
    return { ok: true };
  }
  on(): void {
    /* noop */
  }
  once(): void {
    /* noop */
  }
  removeListener?(): void {
    /* noop */
  }
  close(): void {
    this.closed = true;
  }
}

let dir: string;
let sessionDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-browser-'));
  sessionDir = path.join(dir, 'sessions');
});

afterEach(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('BrowserService：attach 模式（接管渲染端 webview）', () => {
  it('navigate / screenshot / getText 路由到接管的 webContents', async () => {
    const svc = new BrowserService();
    const wc = new FakeWebContents();
    svc.attach(wc);

    const nav = await svc.navigate('https://example.com');
    expect(wc.loadedUrls).toContain('https://example.com');
    expect(nav.url).toBe('https://example.com');
    expect(nav.title).toBe('页面标题');

    const shot = await svc.screenshot();
    expect(shot.base64).toBe('ZmFrZQ==');
    expect(shot.contentId).toMatch(/^screenshot-/);

    const text = await svc.getText();
    expect(text.text).toBe('页面文本');

    expect(svc.isAttached).toBe(true);
  });

  it('close 在 attach 模式下只解除接管，不销毁渲染端 webview', async () => {
    const svc = new BrowserService();
    const wc = new FakeWebContents();
    svc.attach(wc);
    await svc.close();
    expect(wc.closed).toBe(false); // webview 生命周期归渲染端 BrowserPanel
    expect(svc.isAttached).toBe(false);
  });

  it('detach 后再 close 幂等；未打开且无工厂 → 明确提示打开浏览器面板', async () => {
    const svc = new BrowserService();
    svc.detach(); // 未 attach 时安全
    await expect(svc.navigate('https://x.com')).rejects.toThrow(/浏览器窗口未打开/);
    await svc.close(); // 幂等不抛
  });

  it('重新 attach 同一服务实例（面板关闭再打开场景）', async () => {
    const svc = new BrowserService();
    const wc1 = new FakeWebContents();
    svc.attach(wc1);
    svc.detach();
    const wc2 = new FakeWebContents();
    svc.attach(wc2);
    await svc.navigate('https://second.com');
    expect(wc1.loadedUrls).toHaveLength(0);
    expect(wc2.loadedUrls).toContain('https://second.com');
  });
});

describe('BrowserRegistry：会话级浏览器注册表', () => {
  it('attach → for() 返回服务并已接管；detach 解除；dispose 清理', async () => {
    const wc = new FakeWebContents();
    const registry = new BrowserRegistry({ fromId: (id) => (id === 42 ? wc : null) });

    const r = await Promise.resolve(registry.attach('sess-1', 42));
    expect(r.ok).toBe(true);
    const svc = registry.for('sess-1');
    expect(svc?.isAttached).toBe(true);
    await svc?.navigate('https://example.com');
    expect(wc.loadedUrls).toContain('https://example.com');

    registry.detach('sess-1');
    expect(registry.for('sess-1')?.isAttached).toBe(false);

    registry.dispose('sess-1');
    expect(registry.for('sess-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('webContents 不存在 → 明确错误（webview 已销毁）', () => {
    const registry = new BrowserRegistry({ fromId: () => null });
    const r = registry.attach('sess-1', 999);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('999');
  });

  it('多会话隔离：各会话接管各自的 webview', async () => {
    const wcA = new FakeWebContents();
    const wcB = new FakeWebContents();
    const map = new Map<number, unknown>([
      [1, wcA],
      [2, wcB],
    ]);
    const registry = new BrowserRegistry({ fromId: (id) => map.get(id) ?? null });

    expect(registry.attach('a', 1).ok).toBe(true);
    expect(registry.attach('b', 2).ok).toBe(true);
    await registry.for('a')?.navigate('https://a.com');
    await registry.for('b')?.navigate('https://b.com');
    expect(wcA.loadedUrls).toEqual(['https://a.com']);
    expect(wcB.loadedUrls).toEqual(['https://b.com']);
  });
});

describe('端到端：agent 的 browser 工具操作用户打开的 webview', () => {
  it('BrowserPanel 打开（browser:attach）→ agent navigate 同一 webContents', async () => {
    const { IpcBridge, SettingsStore, DiffReviewService, McpManager } = await import(
      '@mozi/desktop'
    );
    const wc = new FakeWebContents();
    const registry = new BrowserRegistry({ fromId: (id) => (id === 7 ? wc : null) });
    const channel = new LoopbackChannel();
    const events: Array<{ type: string; sessionId?: string }> = [];

    // ScriptedProvider：第一轮请求 browser navigate 工具，第二轮收尾。
    const reg = new ProviderRegistry();
    reg.register(
      new ScriptedProvider([], 'scripted', 'scripted-model', {
        '*': [
          {
            toolCalls: [
              {
                name: 'browser',
                arguments: { action: 'navigate', url: 'https://agent-target.com' },
              },
            ],
          },
          { content: '已打开页面。' },
        ],
      }),
    );
    // 默认 executor（deepseek-chat）路由到 scripted provider。
    reg.alias('deepseek-chat', 'scripted');

    const service = new AgentService({
      sessionDir,
      providers: reg,
      emit: (e) => events.push(e),
      // 模拟渲染端 BrowserPanel 已打开：browserRegistry.for(sessionId) 有值。
      browserFor: (sid) => registry.for(sid),
    });

    const bridge = new IpcBridge({
      service,
      settings: new SettingsStore({ filePath: path.join(dir, 'settings.json') }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
      browserRegistry: registry,
    });
    bridge.install();

    const s = await service.create({ workspaceRoot: dir });

    // 渲染端 BrowserPanel dom-ready → 上报 webContentsId（7 → wc）。
    const attachRes = (await channel.invoke('browser:attach', {
      sessionId: s.id,
      webContentsId: 7,
    })) as {
      ok: boolean;
      error?: string;
    };
    expect(attachRes.ok).toBe(true);

    // 注意：引擎在会话创建时已构造（browserFor 当时为 undefined）。
    // 生产链路中 BrowserPanel 打开先于首条消息的会话创建（resume/create 都会重建），
    // 此处用 setWorkspace 触发引擎重建，使 browserAccess 注入生效。
    const target = path.join(dir, 'ws');
    fs.mkdirSync(target, { recursive: true });
    const setRes = (await channel.invoke('session:setWorkspace', {
      sessionId: s.id,
      workspaceRoot: target,
    })) as { ok: boolean };
    expect(setRes.ok).toBe(true);

    // 发送消息 → agent 调 browser 工具 → navigate 路由到用户的 webview。
    const res = service.start({ sessionId: s.id, text: '打开 example' });
    expect(res.accepted).toBe(true);
    await waitFor(() => events.some((e) => e.type === 'task.completed'));
    expect(wc.loadedUrls).toContain('https://agent-target.com');

    // 面板关闭 → browser:detach → 服务解除接管。
    const detachRes = (await channel.invoke('browser:detach', { sessionId: s.id })) as {
      ok: boolean;
    };
    expect(detachRes.ok).toBe(true);
    expect(registry.for(s.id)?.isAttached).toBe(false);
    await service.shutdown();
  });
});

// ── helpers ───────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
