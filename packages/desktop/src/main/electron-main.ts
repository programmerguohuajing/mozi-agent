/**
 * Electron 主进程入口（M10 §10.1/§10.2/§10.4/§10.7）。
 *
 * 组装：AgentService（会话池）+ IpcBridge（channel 路由）+ 设置/密钥 + Diff + MCP 管理，
 * 并把 §10.3 的通道映射到 Electron IPC。
 *
 * **运行时依赖 `electron`**（未在本仓库安装；`pnpm add -D electron` 后 `pnpm dev`）。
 * 为保持「无重依赖 + 可类型检查」，本文件通过 `ElectronModule` 最小接口延迟绑定 electron，
 * 不 `import 'electron'`（静态），因此 tsc 可编译、其余部分可在纯 Node 测试。
 */
import path from 'node:path';
import { ProviderRegistry } from '@mozi/providers';
import { AgentService } from './agent-service.js';
import { IpcBridge, type ScreenCapturer } from './ipc-bridge.js';
import { DiffReviewService } from './diff-service.js';
import { SettingsStore, type SafeStorageLike } from './settings-store.js';
import { McpManager } from './mcp-manager.js';
import {
  ElectronChannelServer,
  type IpcMainLike,
  type WebContentsLike,
} from './electron-transport.js';

/** electron 模块的最小接口（延迟绑定，避免静态依赖）。 */
export interface ElectronModule {
  app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed' | 'before-quit' | 'activate', listener: () => void): void;
    getPath(name: 'userData'): string;
    quit(): void;
    getVersion(): string;
  };
  BrowserWindow: new (opts: unknown) => ElectronBrowserWindow;
  ipcMain: IpcMainLike;
  safeStorage?: SafeStorageLike;
  Notification?: new (opts: { title: string; body: string }) => { show(): void };
  /** 屏幕捕获源（输入栏"截图"按钮：截取整屏 → 标注 → 作为附件）。 */
  desktopCapturer?: {
    getSources(opts: {
      types: Array<'screen' | 'window'>;
      thumbnailSize?: { width: number; height: number };
    }): Promise<ElectronDesktopSource[]>;
  };
  /** 显示器信息（用于按物理像素分辨率截图，避免高 DPI 下模糊）。 */
  screen?: {
    getPrimaryDisplay(): {
      id: number;
      size: { width: number; height: number };
      scaleFactor: number;
    };
  };
}

/** Electron `desktopCapturer` 返回的单个捕获源（最小契约）。 */
export interface ElectronDesktopSource {
  id: string;
  name: string;
  display_id?: string;
  thumbnail: {
    toPNG(): Buffer;
    getSize(): { width: number; height: number };
  };
}

export interface ElectronBrowserWindow extends WebContentsLike {
  loadFile(file: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  focus(): void;
  on(event: 'closed', listener: () => void): void;
  webContents: WebContentsLike;
}

export interface BootOptions {
  /** 注入 electron（生产从动态 import 取；测试可注入 mock）。 */
  electron: ElectronModule;
  /** 渲染进程入口 HTML。 */
  rendererIndex: string;
  /** preload 脚本路径。 */
  preloadPath: string;
  /** 覆盖设置文件路径（测试）。 */
  settingsFile?: string;
  /** dev server URL（Vite HMR），有则 loadURL。 */
  devServerUrl?: string;
  /** 窗口图标路径（默认 build/icon.png）。 */
  iconPath?: string;
}

export interface BootedApp {
  service: AgentService;
  bridge: IpcBridge;
  settings: SettingsStore;
  diff: DiffReviewService;
  mcp: McpManager;
  createWindow(sessionId?: string): ElectronBrowserWindow;
  shutdown(): Promise<void>;
}

/**
 * 启动主进程（组装全部服务 + 注册 IPC + 创建首个窗口）。
 * 返回已启动的应用句柄，供测试与生命周期管理使用。
 */
export async function boot(opts: BootOptions): Promise<BootedApp> {
  const { electron } = opts;
  await electron.app.whenReady();

  const userData = electron.app.getPath('userData');
  const settingsFile = opts.settingsFile ?? path.join(userData, 'settings.json');

  const windows: ElectronBrowserWindow[] = [];
  const settings = new SettingsStore({
    filePath: settingsFile,
    ...(electron.safeStorage ? { safeStorage: electron.safeStorage } : {}),
  });

  // 会话池（providers 由设置驱动；密钥只在主进程）。
  const providers = new ProviderRegistry();

  // Diff 审阅：绑定到当前活动 workspace（会话级别由 AgentService 提供 workspaceRoot）。
  const diff = new DiffReviewService({
    readFile: (file) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return AgentServiceReadFile(file);
      } catch {
        return null;
      }
    },
    writeFile: (file, content) => AgentServiceWriteFile(file, content),
  });

  const mcp = new McpManager({
    connect: async () => ({ toolCount: 0 }), // 真实连接由 @mozi/mcp-client 注入
    disconnect: async () => {},
    persist: (servers) => settings.applyPatch({ mcpServers: servers }),
    initial: (settings.getAll().mcpServers as never[]) ?? [],
  });

  const channel = new ElectronChannelServer(electron.ipcMain, () => windows);
  let bridge: IpcBridge;

  /** 整屏截图（输入栏"截图"按钮）：thumbnailSize 取物理像素，避免高 DPI 下模糊。 */
  const captureScreen: ScreenCapturer = async () => {
    const dc = electron.desktopCapturer;
    if (!dc) throw new Error('desktopCapturer 不可用（主进程未注入 electron.desktopCapturer）');
    const display = electron.screen?.getPrimaryDisplay();
    const scale = display?.scaleFactor ?? 1;
    const width = Math.max(1, Math.round((display?.size.width ?? 1280) * scale));
    const height = Math.max(1, Math.round((display?.size.height ?? 800) * scale));
    const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const primary =
      (display && sources.find((s) => s.display_id && String(s.display_id) === String(display.id))) ||
      sources[0];
    if (!primary) throw new Error('未找到可截图的屏幕源（desktopCapturer 返回空）');
    const size = primary.thumbnail.getSize();
    return { base64: primary.thumbnail.toPNG().toString('base64'), width: size.width, height: size.height };
  };

  const service = new AgentService({
    sessionDir: path.join(userData, 'sessions'),
    providers,
    policyMode: settings.policyMode(),
    emit: (event) => bridge.onEngineEvent(event),
    emitStatus: (sessionId, state) => bridge.onSessionStatus(sessionId, state),
    sandboxLevel: settings.sandboxLevel(),
  });

  bridge = new IpcBridge({
    service,
    settings,
    diff,
    mcp,
    channel,
    ...(electron.desktopCapturer ? { captureScreen } : {}),
  });
  bridge.install();

  const iconPath = opts.iconPath ?? path.join(path.dirname(opts.rendererIndex), 'build', 'icon.png');
  const createWindow = (sessionId?: string): ElectronBrowserWindow => {
    const win = new electron.BrowserWindow({
      width: 1280,
      height: 840,
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        // 进程安全（§10.2）：隔离上下文、禁用 node 集成、白名单 preload。
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: opts.preloadPath,
      },
    });
    windows.push(win);
    win.on('closed', () => {
      const idx = windows.indexOf(win);
      if (idx >= 0) windows.splice(idx, 1);
      // 窗口关闭 ≠ 会话销毁：引擎继续后台跑（§10.4）。
      if (sessionId) service.detachWindow(sessionId, String(windows.length));
    });
    if (opts.devServerUrl) void win.loadURL(opts.devServerUrl);
    else void win.loadFile(opts.rendererIndex);
    return win;
  };

  const shutdown = async (): Promise<void> => {
    await service.shutdown(10_000); // 全部会话 flush + abort（10s 上限）
  };

  electron.app.on('before-quit', () => {
    void shutdown();
  });
  electron.app.on('window-all-closed', () => {
    // macOS 保留应用存活（惯例）；其他平台后台运行开关决定是否退出。
    if (process.platform !== 'darwin' && !settings.backgroundRun()) electron.app.quit();
  });

  createWindow();
  return { service, bridge, settings, diff, mcp, createWindow, shutdown };
}

// ── 供 diff 服务使用的简易文件读写（workspace 校验由上层负责）──
import fs from 'node:fs';
function AgentServiceReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
function AgentServiceWriteFile(file: string, content: string): void {
  fs.writeFileSync(file, content, 'utf8');
}

export { DiffReviewService, SettingsStore, McpManager, AgentService, IpcBridge };
