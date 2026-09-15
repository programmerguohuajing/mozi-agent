/**
 * BrowserRegistry：sessionId → BrowserService 的注册表。
 *
 * 渲染端 BrowserPanel 打开时经 `browser:attach` 把 `<webview>` 的
 * guest webContentsId 报给主进程；此处按会话建 BrowserService 并接管，
 * AgentService 经 `browserFor(sessionId)` 拿到后注入引擎 —— agent 的
 * browser 工具与用户看到的浏览器面板操作同一页面。
 */
import {
  BrowserService,
  type BrowserViewFactory,
  type BrowserWebContentsLike,
} from './browser-service.js';

export interface BrowserRegistryDeps {
  /** 按 id 查找 webContents（electron.webContents.fromId）。 */
  fromId: (id: number) => unknown;
  /** BrowserView 工厂（electron.BrowserView）；注入后 agent 可自主创建浏览器（无需用户手动打开面板）。 */
  createView?: BrowserViewFactory;
  /** 主窗口边界（自建 BrowserView 时定位）。 */
  parentBounds?: { x: number; y: number; width: number; height: number };
}

export class BrowserRegistry {
  private readonly services = new Map<string, BrowserService>();

  constructor(private readonly deps: BrowserRegistryDeps) {}

  /**
   * 接管会话的 webview（面板打开 / webview 重建时调用，幂等）。
   * webContents 不存在（webview 已销毁）返回明确错误。
   */
  attach(sessionId: string, webContentsId: number): { ok: boolean; error?: string } {
    const wc = this.deps.fromId(webContentsId);
    if (!wc) {
      return { ok: false, error: `webContents #${webContentsId} 不存在（webview 可能已销毁）` };
    }
    let svc = this.services.get(sessionId);
    if (!svc) {
      svc = new BrowserService({
        createView: this.deps.createView,
        parentBounds: this.deps.parentBounds,
      });
      this.services.set(sessionId, svc);
    }
    svc.attach(wc as BrowserWebContentsLike);
    return { ok: true };
  }

  /** 解除接管（面板关闭；引擎侧保留服务实例，重新打开时无需重建）。 */
  detach(sessionId: string): void {
    this.services.get(sessionId)?.detach();
  }

  /**
   * 会话的 BrowserService（引擎注入用）。
   * 未打开过浏览器面板时：若 createView 工厂可用，自动创建服务实例（agent 可自主浏览）；
   * 否则返回 undefined（browser 工具将给出「请先打开浏览器面板」提示）。
   */
  for(sessionId: string): BrowserService | undefined {
    let svc = this.services.get(sessionId);
    if (!svc && this.deps.createView) {
      svc = new BrowserService({
        createView: this.deps.createView,
        parentBounds: this.deps.parentBounds,
      });
      this.services.set(sessionId, svc);
    }
    return svc;
  }

  /** 会话销毁时清理。 */
  dispose(sessionId: string): void {
    const svc = this.services.get(sessionId);
    if (svc) {
      void svc.close();
      this.services.delete(sessionId);
    }
  }

  /** 已注册的会话数（诊断）。 */
  get size(): number {
    return this.services.size;
  }
}
