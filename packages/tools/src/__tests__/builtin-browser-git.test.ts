import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTool, browserTool, type BrowserAccess } from '@mozi/tools';
import { Workspace } from '@mozi/tools';

/**
 * 内置 Git 工具测试：结构化 Git 操作（status/diff/log/branch/add/commit/show）。
 * 内置浏览器工具测试：BrowserAccess 注入 + 各 action 路由。
 */

let tmp: string;
let ws: Workspace;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-git-'));
  execSync('git init', { cwd: tmp });
  execSync('git config user.email "test@test.com"', { cwd: tmp });
  execSync('git config user.name "Test"', { cwd: tmp });
  ws = new Workspace(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Git 工具 ────────────────────────────────────────────────────────

describe('内置 Git 工具', () => {
  it('status：空仓库返回空列表', async () => {
    const result = await gitTool.execute(
      { action: 'status' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content) as { total: number; untracked: unknown[] };
    expect(data.total).toBe(0);
  });

  it('add + status：检测新增文件', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    const result = await gitTool.execute(
      { action: 'status' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    const data = JSON.parse(result.content) as { untracked: { path: string }[] };
    expect(data.untracked.length).toBe(1);
    expect(data.untracked[0]!.path).toBe('a.txt');
  });

  it('add + commit + log：完整提交流程', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await gitTool.execute(
      { action: 'add', files: ['a.txt'] },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    const commitResult = await gitTool.execute(
      { action: 'commit', message: 'initial commit' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    expect(commitResult.isError).toBeFalsy();
    const logResult = await gitTool.execute(
      { action: 'log', limit: 5 },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    const entries = JSON.parse(logResult.content) as { message: string; author: string }[];
    expect(entries.length).toBe(1);
    expect(entries[0]!.message).toBe('initial commit');
    expect(entries[0]!.author).toBe('Test');
  });

  it('diff：显示未暂存变更', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\n');
    execSync('git add a.txt', { cwd: tmp });
    execSync('git commit -m "v1"', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2\n');
    const result = await gitTool.execute(
      { action: 'diff' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('line2');
  });

  it('branch：列出分支', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    execSync('git add . && git commit -m "init"', { cwd: tmp });
    const result = await gitTool.execute(
      { action: 'branch' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    const branches = JSON.parse(result.content) as { name: string; current: boolean }[];
    expect(branches.length).toBe(1);
    expect(branches[0]!.current).toBe(true);
  });

  it('show：查看指定提交', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    execSync('git add . && git commit -m "init"', { cwd: tmp });
    const hash = execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();
    const result = await gitTool.execute(
      { action: 'show', ref: hash },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('init');
  });

  it('非 git 仓库：返回错误', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-nogit-'));
    try {
      const nonWs = new Workspace(nonGit);
      const result = await gitTool.execute(
        { action: 'status' },
        { workspace: nonWs, signal: new AbortController().signal, sessionId: 's1' },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Not a git repository');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// ── 浏览器工具 ──────────────────────────────────────────────────────

function mockBrowser(): BrowserAccess {
  let currentUrl = '';
  let pageTitle = 'Mock Page';
  return {
    async navigate(url) {
      currentUrl = url;
      pageTitle = `Title for ${url}`;
      return { title: pageTitle, url, status: 200 };
    },
    async screenshot() {
      return { contentId: 'mock-1', base64: 'mockbase64data' };
    },
    async getText() {
      return { text: 'Hello from mock page', truncated: false };
    },
    async getHtml() {
      return { html: '<html><body>Mock</body></html>', truncated: false };
    },
    async click(selector) {
      if (selector === '.not-found') return { ok: false, error: 'element not found' };
      return { ok: true };
    },
    async fill(selector, value) {
      if (selector === '.not-found') return { ok: false, error: 'element not found' };
      return { ok: true };
    },
    async eval(script) {
      if (script === 'throw new Error("boom")') return { result: undefined, error: 'boom' };
      return { result: 'eval result' };
    },
    async close() {},
    async listTabs() {
      return [{ id: 'tab-1', url: currentUrl, title: pageTitle, active: true }];
    },
  };
}

describe('内置浏览器工具', () => {
  it('未注入 BrowserAccess → 明确错误', async () => {
    const result = await browserTool.execute(
      { action: 'navigate', url: 'https://example.com' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Browser access not available');
  });

  it('navigate：导航并返回页面信息', async () => {
    const result = await browserTool.execute(
      { action: 'navigate', url: 'https://example.com' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content) as { title: string; url: string; status: number };
    expect(data.url).toBe('https://example.com');
    expect(data.status).toBe(200);
  });

  it('get_text：提取文本', async () => {
    const result = await browserTool.execute(
      { action: 'get_text' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Hello from mock page');
  });

  it('get_html：获取 HTML', async () => {
    const result = await browserTool.execute(
      { action: 'get_html' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<html>');
  });

  it('click：成功点击', async () => {
    const result = await browserTool.execute(
      { action: 'click', selector: '#btn' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Clicked: #btn');
  });

  it('click：元素不存在', async () => {
    const result = await browserTool.execute(
      { action: 'click', selector: '.not-found' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBe(true);
  });

  it('fill：填充表单', async () => {
    const result = await browserTool.execute(
      { action: 'fill', selector: '#input', value: 'test value' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Filled #input');
  });

  it('eval：执行 JavaScript', async () => {
    const result = await browserTool.execute(
      { action: 'eval', script: '1 + 1' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('eval result');
  });

  it('list_tabs：列出标签页', async () => {
    const result = await browserTool.execute(
      { action: 'list_tabs' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    const tabs = JSON.parse(result.content) as { id: string; active: boolean }[];
    expect(tabs.length).toBe(1);
    expect(tabs[0]!.active).toBe(true);
  });

  it('close：关闭浏览器', async () => {
    const result = await browserTool.execute(
      { action: 'close' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Browser closed');
  });

  it('navigate 缺 url → 错误', async () => {
    const result = await browserTool.execute(
      { action: 'navigate' },
      { workspace: ws, signal: new AbortController().signal, sessionId: 's1', browser: mockBrowser() },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('requires a url');
  });
});