/**
 * BrowserService：桌面端内置浏览器服务（Electron BrowserView 实现）。
 *
 * 实现 @mozi/tools 的 BrowserAccess 接口，注入引擎 ToolContext.browser，
 * 使 agent 的 `browser` 工具可直接操作内置 Chromium 浏览器。
 *
 * 架构：
 *   - 每个 BrowserService 管理一个 BrowserView（单标签页，可扩展为多标签）
 *   - 导航/截图/文本提取/交互通过 BrowserView.webContents API
 *   - 截图走 webContents.capturePage() → NativeImage → base64 PNG
 *   - 安全：禁用 nodeIntegration、启用 contextIsolation、限制 eval 脚本超时
 *
 * 运行时依赖 electron（未在本仓库安装）；通过最小接口延迟绑定，tsc 可编译。
 */
import type { BrowserAccess } from '@mozi/tools';

/** Electron BrowserView 的最小契约（避免静态依赖 electron 类型）。 */
export interface BrowserViewLike {
  webContents: BrowserWebContentsLike;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setAutoResize(options: { width: boolean; height: boolean }): void;
}

export interface BrowserWebContentsLike {
  loadURL(url: string, opts?: { userAgent?: string }): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  capturePage(): Promise<{ toDataURL(): string; toPNG(): Buffer }>;
  executeJavaScript(script: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  close?(): void;
}

/** BrowserView 工厂（由 electron-main 注入真实实现）。 */
export type BrowserViewFactory = (opts: { webPreferences: { nodeIntegration: boolean; contextIsolation: boolean } }) => BrowserViewLike;

export interface BrowserServiceOptions {
  /** BrowserView 工厂（electron.BrowserView）。 */
  createView?: BrowserViewFactory;
  /** 主窗口容器（用于附加 BrowserView）。 */
  parentBounds?: { x: number; y: number; width: number; height: number };
  /** 页面加载超时（默认 15000ms）。 */
  loadTimeoutMs?: number;
  /** eval 脚本超时（默认 5000ms）。 */
  evalTimeoutMs?: number;
}

interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/**
 * BrowserService：管理内置浏览器生命周期，实现 BrowserAccess 接口。
 *
 * 无 electron 时可作为 stub 编译（createView 未注入则操作返回明确错误）。
 */
export class BrowserService implements BrowserAccess {
  private view: BrowserViewLike | null = null;
  private readonly tabs: Map<string, TabInfo> = new Map();
  private activeTabId: string | null = null;
  private readonly loadTimeoutMs: number;
  private readonly evalTimeoutMs: number;
  private readonly createView?: BrowserViewFactory;
  private readonly parentBounds: { x: number; y: number; width: number; height: number };

  constructor(opts: BrowserServiceOptions = {}) {
    this.createView = opts.createView;
    this.parentBounds = opts.parentBounds ?? { x: 0, y: 0, width: 800, height: 600 };
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 15_000;
    this.evalTimeoutMs = opts.evalTimeoutMs ?? 5_000;
  }

  private ensureView(): BrowserViewLike {
    if (!this.createView) throw new Error('BrowserView factory not injected (electron not available)');
    if (!this.view) {
      this.view = this.createView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      this.view.setBounds(this.parentBounds);
      this.view.setAutoResize({ width: true, height: true });
    }
    return this.view;
  }

  async navigate(url: string, opts?: { waitMs?: number }): Promise<{ title: string; url: string; status: number }> {
    const view = this.ensureView();
    const wc = view.webContents;

    // 加载 URL（带超时）
    const loadPromise = wc.loadURL(url);
    const timeoutMs = opts?.waitMs ?? this.loadTimeoutMs;
    await Promise.race([
      loadPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Page load timeout (${timeoutMs}ms): ${url}`)), timeoutMs),
      ),
    ]);

    const title = wc.getTitle();
    const currentUrl = wc.getURL();
    const tabId = this.activeTabId ?? `tab-${Date.now()}`;
    const tabInfo: TabInfo = { id: tabId, url: currentUrl, title, active: true };
    this.tabs.set(tabId, tabInfo);
    this.activeTabId = tabId;

    return { title, url: currentUrl, status: 200 };
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<{ contentId: string; base64: string }> {
    const view = this.ensureView();
    const wc = view.webContents;
    // fullPage 暂不支持（Electron capturePage 只截可见区域；全页需 scroll+拼接，留待 v2）
    const image = await wc.capturePage();
    const base64 = image.toPNG().toString('base64');
    const contentId = `screenshot-${Date.now()}`;
    return { contentId, base64 };
  }

  async getText(): Promise<{ text: string; truncated: boolean }> {
    const view = this.ensureView();
    const wc = view.webContents;
    // 在页面上下文提取纯文本
    const text = await this.evalWithTimeout(wc, `document.body.innerText`);
    const result = typeof text === 'string' ? text : String(text ?? '');
    return { text: result, truncated: false };
  }

  async getHtml(): Promise<{ html: string; truncated: boolean }> {
    const view = this.ensureView();
    const wc = view.webContents;
    const html = await this.evalWithTimeout(wc, `document.documentElement.outerHTML`);
    const result = typeof html === 'string' ? html : String(html ?? '');
    return { html: result, truncated: false };
  }

  async click(selector: string): Promise<{ ok: boolean; error?: string }> {
    const view = this.ensureView();
    const wc = view.webContents;
    try {
      const result = await this.evalWithTimeout(wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'element not found' };
        (el as HTMLElement).click();
        return { ok: true };
      })()`);
      const r = result as { ok: boolean; error?: string };
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async fill(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const view = this.ensureView();
    const wc = view.webContents;
    try {
      const result = await this.evalWithTimeout(wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)}) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return { ok: false, error: 'element not found' };
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`);
      const r = result as { ok: boolean; error?: string };
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async eval(script: string): Promise<{ result: unknown; error?: string }> {
    const view = this.ensureView();
    const wc = view.webContents;
    try {
      const result = await this.evalWithTimeout(wc, script);
      return { result };
    } catch (e) {
      return { result: undefined, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async close(): Promise<void> {
    if (this.view?.webContents.close) {
      this.view.webContents.close();
    }
    this.view = null;
    this.tabs.clear();
    this.activeTabId = null;
  }

  async listTabs(): Promise<Array<{ id: string; url: string; title: string; active: boolean }>> {
    return [...this.tabs.values()];
  }

  private async evalWithTimeout(wc: BrowserWebContentsLike, script: string): Promise<unknown> {
    return Promise.race([
      wc.executeJavaScript(script),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Script timeout (${this.evalTimeoutMs}ms)`)), this.evalTimeoutMs),
      ),
    ]);
  }
}