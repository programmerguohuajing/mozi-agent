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
import { McpBridge, type McpServerConfig, type McpServerEntry } from '@mozi/mcp-client';
import type { ApiFormat, McpAddRequest } from '@mozi/protocol';
import {
  AnthropicProvider,
  GeminiProvider,
  type LLMProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  ProviderRegistry,
} from '@mozi/providers';
import { ToolRegistry } from '@mozi/tools';
import { AgentService } from './agent-service.js';
import { BrowserRegistry } from './browser-registry.js';
import { DiffReviewService } from './diff-service.js';
import {
  ElectronChannelServer,
  type IpcMainLike,
  type WebContentsLike,
} from './electron-transport.js';
import { IpcBridge, type ScreenCapturer } from './ipc-bridge.js';
import { McpManager } from './mcp-manager.js';
import { type SafeStorageLike, SettingsStore } from './settings-store.js';
import { TaskSchedulerHost } from './tasks-host.js';

/** 默认系统托盘图标（16×16 内嵌 PNG，蓝紫渐变 + 白色 M）。 */
const DEFAULT_TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVR4nKWTXQuCQBBF57dGBBERhJllZqaZCRERREQ/0u/XG1MtDcsGYuf9zJ29u0uk0U8zDA4ZhkmO0T7HOM4x2eWYRgWssIAdFtCdF700QxvZ2RZwgxLepsRfsu+XCNafIV3lyKvwlxyvKpBJVkhZIeWEB5iSdVklM1JO3QpkWpthmWFZJTNSPi5rkOnMjFpbJjNSPi1qkKkwlawXxkj57NQgU9sqWV+bkfJlXoNMV2Vqm5MZKV/tBtS2bU5mpHybNe+X+OuR6IXp8l0N6Co/rOb7obrKTyIa1Zi+o0sWAAAAAElFTkSuQmCC';

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
  Menu: {
    setApplicationMenu(menu: unknown): void;
    /** 构建托盘右键菜单。 */
    buildFromTemplate(template: Array<Record<string, unknown>>): ElectronMenuLike;
  };
  Tray?: new (image: unknown) => ElectronTrayLike;
  nativeImage?: ElectronNativeImageLike;
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
  /** 原生对话框（新建任务时选择本地文件夹作为 workspace）。 */
  dialog?: {
    showOpenDialog(options: {
      title?: string;
      defaultPath?: string;
      buttonLabel?: string;
      properties: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'>;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  /**
   * webContents 模块（任务浏览器面板：按 id 查找 webview 标签的 guest webContents）。
   * 返回的实例将被 BrowserRegistry 接管，供 agent 的 browser 工具操作。
   */
  webContents?: {
    fromId(id: number): unknown | null;
  };
  /** BrowserView 构造器（agent 自主浏览模式：无 UI 面板时创建 headless 浏览器）。 */
  BrowserView?: new (opts: {
    webPreferences: { nodeIntegration: boolean; contextIsolation: boolean };
  }) => unknown;
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

/** Electron `Menu` 的最小契约（用于托盘右键菜单）。 */
export interface ElectronMenuLike {
  close?(): void;
  popup?(): void;
}

/** Electron `NativeImage` 的最小契约（托盘图标加载 / 缩放）。 */
export interface ElectronImageLike {
  resize(opts: { width: number; height: number }): ElectronImageLike;
  isEmpty?: () => boolean;
}

/** Electron `nativeImage` 模块的最小契约。 */
export interface ElectronNativeImageLike {
  createFromDataURL(dataUrl: string): ElectronImageLike;
  /** 从文件加载（托盘图标优先用应用图标，比内嵌 16×16 小图清晰）。 */
  createFromPath?(p: string): ElectronImageLike;
}

/** Electron `Tray` 的最小契约（系统托盘常驻，§10.7）。 */
export interface ElectronTrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: ElectronMenuLike): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
}

export interface ElectronBrowserWindow extends WebContentsLike {
  loadFile(file: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  focus(): void;
  on(event: 'closed', listener: () => void): void;
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
  hide(): void;
  show(): void;
  isMinimized(): boolean;
  restore(): void;
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
  /** 系统托盘图标 data URL（默认内嵌 16×16 图标）。 */
  trayIconDataUrl?: string;
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
  // 真正退出中标志：托盘模式拦截关闭时据此放行（退出菜单 / app.quit）。
  let isQuitting = false;
  // 系统托盘实例（仅当 electron 提供 Tray/nativeImage 且启用时创建）。
  let tray: ElectronTrayLike | null = null;

  // 移除默认菜单栏（File / Edit / View / Window / Help）
  if (electron.Menu) electron.Menu.setApplicationMenu(null);
  const settings = new SettingsStore({
    filePath: settingsFile,
    ...(electron.safeStorage ? { safeStorage: electron.safeStorage } : {}),
  });

  // 会话池（providers 由设置驱动；密钥只在主进程）。
  const providers = new ProviderRegistry();

  /**
   * 按上游 API 格式实例化适配器（§10.5④ 上游格式选择）。
   * baseUrl 形态约定：openai 含版本段（…/v1）；其余三种不含。
   * model 为空 → 网关自动路由（FreeLLMAPI 等聚合网关自行选模型）。
   */
  const instantiateProvider = (
    format: ApiFormat,
    model: string,
    baseUrl: string | undefined,
    apiKey: () => string | undefined,
    id: string,
  ): LLMProvider => {
    switch (format) {
      case 'anthropic':
        return new AnthropicProvider({ model, baseUrl, apiKey, id });
      case 'gemini':
        return new GeminiProvider({ model, baseUrl, apiKey, id });
      case 'openai-responses':
        return new OpenAIResponsesProvider({ model, baseUrl, apiKey, id });
      default:
        return new OpenAICompatibleProvider({
          baseUrl: baseUrl ?? 'https://api.openai.com/v1',
          apiKey,
          model,
          id,
        });
    }
  };

  /**
   * 依据设置重建 provider 注册表。
   * 一个提供商可注册多个模型实例（models 列表逐个注册，本地名 = 模型名）；
   * 旧数据兼容：modelMap（映射）> models（多模型直连）> model（单模型）> 自动路由。
   */
  const rebuildProviders = (): void => {
    providers.clear();
    const all = settings.getAll() as {
      providers: Record<
        string,
        {
          model: string;
          models?: string[];
          baseUrl?: string;
          apiFormat?: ApiFormat;
          modelMap?: Record<string, string>;
        }
      >;
    };
    for (const [id, spec] of Object.entries(all.providers ?? {})) {
      const apiKey = (): string | undefined => settings.getApiKey(id);
      const modelMap = spec.modelMap ?? {};
      const models = spec.models ?? [];
      // 注册条目（本地名 → 上游模型名）：
      //   映射：本地名 → 上游名；多模型直连：模型名即本身；
      //   单模型直连：模型名即本身；自动路由（全空）：本地名 = provider id，上游不传模型。
      const entries: Array<[string, string]> =
        Object.keys(modelMap).length > 0
          ? Object.entries(modelMap)
          : models.length > 0
            ? models.map((m) => [m, m] as [string, string])
            : spec.model
              ? [[spec.model, spec.model]]
              : [[id, '']];
      for (const [localName, upstreamModel] of entries) {
        const provider = instantiateProvider(
          spec.apiFormat ?? 'openai',
          upstreamModel,
          spec.baseUrl,
          apiKey,
          localName,
        );
        providers.register(provider);
        if (localName !== provider.id) providers.alias(localName, provider.id);
      }
    }
  };
  rebuildProviders();

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

  /**
   * McpAddRequest → mcp-client 传输层配置（M8 §8.5）。
   * 透传 headers（如 Authorization）/ auth / timeoutMs / cwd。
   */
  const toMcpTransportConfig = (spec: McpAddRequest): McpServerConfig => {
    if (spec.transport === 'stdio') {
      return {
        kind: 'stdio',
        id: spec.id,
        command: spec.command ?? '',
        args: spec.args ?? [],
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      };
    }
    return {
      kind: 'http',
      id: spec.id,
      url: spec.url ?? '',
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.auth ? { auth: spec.auth } : {}),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    };
  };

  /**
   * MCP 连接器（§10.5⑦）：临时 ToolRegistry 挂载 server 工具并计数，
   * 全量重连时替换（mcp-client 的 McpBridge 面向会话引擎，此处仅做连通性探测；
   * 会话引擎侧的 MCP 注入由 ensurePool 的 mcpServers 传入）。
   */
  let mcpBridge: McpBridge | undefined;
  const mcpRegistry = new ToolRegistry();
  const connectMcpServer = async (spec: McpAddRequest): Promise<{ toolCount: number }> => {
    // 断开旧连接（重连场景）
    if (mcpBridge) {
      await mcpBridge.closeAll().catch(() => {});
      mcpBridge = undefined;
    }
    const entries: McpServerEntry[] = [{ config: toMcpTransportConfig(spec) }];
    mcpBridge = new McpBridge(entries, { registry: mcpRegistry });
    await mcpBridge.connectAll();
    const tools = mcpBridge.tools();
    if (tools.length === 0) throw new Error(`server "${spec.id}" 连接成功但未暴露任何工具`);
    return { toolCount: tools.length };
  };

  const mcp = new McpManager({
    connect: connectMcpServer,
    disconnect: async (id) => {
      if (mcpBridge && mcpBridge.tools().length > 0) {
        await mcpBridge.closeAll().catch(() => {});
      }
      void id;
    },
    persist: (servers) => settings.applyPatch({ mcpServers: servers }),
    initial: (settings.getAll().mcpServers as never[]) ?? [],
  });

  /**
   * 任务浏览器注册表：
   *   - attach 模式：渲染端 BrowserPanel 的 `<webview>` 经 browser:attach 上报 guest
   *     webContentsId，agent 的 browser 工具操作用户看到的同一页面。
   *   - 自建模式：注入 createView 工厂后，agent 无需用户手动打开面板即可自主创建
   *     BrowserView 浏览网页（headless，不可见），实现「browser use」能力。
   */
  const browserRegistry = new BrowserRegistry({
    fromId: (id) => electron.webContents?.fromId(id) ?? null,
    createView: (opts) => {
      const BV = electron.BrowserView;
      if (!BV) throw new Error('electron.BrowserView 不可用（主进程未注入）');
      return new BV(opts) as unknown as import('./browser-service.js').BrowserViewLike;
    },
  });

  /**
   * 定时任务宿主（M4.5 / M13）：加载 userData/tasks/tasks.json，每分钟 tick；
   * 任务状态变化时刷新全部窗口（渲染端 schedule:list 重取）。
   */
  const tasksHost = new TaskSchedulerHost({
    dataDir: userData,
    providers,
    // tick 到期 / 手动启停删除 / 运行完成 → 推送 schedule:changed，渲染端自动刷新。
    onTaskEvent: () => bridge.notifyScheduleChanged(),
  });
  tasksHost.start();

  const channel = new ElectronChannelServer(electron.ipcMain, () => windows);
  // biome-ignore lint/style/useConst: service 的 emit 闭包引用 bridge，二者循环依赖需先声明后赋值。
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
      (display &&
        sources.find((s) => s.display_id && String(s.display_id) === String(display.id))) ||
      sources[0];
    if (!primary) throw new Error('未找到可截图的屏幕源（desktopCapturer 返回空）');
    const size = primary.thumbnail.getSize();
    return {
      base64: primary.thumbnail.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
    };
  };

  const service = new AgentService({
    sessionDir: path.join(userData, 'sessions'),
    providers,
    policyMode: settings.policyMode(),
    emit: (event) => bridge.onEngineEvent(event),
    emitStatus: (sessionId, state) => bridge.onSessionStatus(sessionId, state),
    sandboxLevel: settings.sandboxLevel(),
    // MCP：会话引擎每次构造时实时读取当前配置（编辑 mcp.json 后新会话即刻生效）。
    mcpServers: () => (mcp.config() ?? []).map((spec) => ({ config: toMcpTransportConfig(spec) })),
    // 任务浏览器面板：会话引擎的 browser 工具路由到用户打开的 webview。
    browserFor: (sessionId) => browserRegistry.for(sessionId),
  });

  /**
   * 原生目录选择框（新建任务：选本地文件夹作为 workspace，§10.5①）。
   * 用户取消 → 返回 null（渲染进程据此不创建会话）。
   */
  const pickWorkspace = async (): Promise<string | null> => {
    const d = electron.dialog;
    if (!d) return null;
    const r = await d.showOpenDialog({
      title: '选择任务文件夹（workspace）',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0] ?? null;
  };

  bridge = new IpcBridge({
    service,
    settings,
    diff,
    mcp,
    channel,
    // provider 增删改后实时重建注册表（registry 实例不变，Map 原地更新，
    // 已创建会话的引擎引用同一实例，即刻生效）。
    onProvidersChanged: rebuildProviders,
    ...(electron.desktopCapturer ? { captureScreen } : {}),
    ...(electron.dialog ? { pickWorkspace } : {}),
    ...(electron.webContents ? { browserRegistry } : {}),
    // 定时任务宿主（schedule:* 通道）。
    tasks: tasksHost,
  });
  bridge.install();

  const iconPath =
    opts.iconPath ?? path.join(path.dirname(opts.rendererIndex), 'build', 'icon.png');

  const createWindow = (sessionId?: string): ElectronBrowserWindow => {
    const win = new electron.BrowserWindow({
      width: 1280,
      height: 840,
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        // 进程安全（§10.2）：隔离上下文、禁用 node 集成、白名单 preload。
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox: false —— preload 在 asar 内时 sandbox 模式无法加载（Electron 33 限制），
        // contextIsolation: true 已保证渲染进程无法直接访问 Node API，安全性足够。
        sandbox: false,
        // 任务浏览器面板（BrowserPanel 的 <webview> 标签）需要启用 webview。
        webviewTag: true,
        preload: opts.preloadPath,
      },
    });
    windows.push(win);
    win.on('close', (event) => {
      // 托盘模式：拦截"关闭"，隐藏到托盘常驻而非退出（§10.7）。
      if (!isQuitting && settings.closeBehavior() === 'tray') {
        // 托盘尚未就绪（启动时创建失败 / 环境延迟可用）→ 先补建，保证关闭后有恢复入口。
        if (!tray) createTray();
        if (tray) {
          event.preventDefault();
          win.hide();
        }
      }
    });
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

  /** 恢复主窗口（托盘点击 / 菜单唤起）。无存活窗口则重建。 */
  const showMainWindow = (): void => {
    const win = windows[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    createWindow();
  };

  /**
   * 创建系统托盘（关闭到托盘时用于唤起 / 退出，§10.7）。
   *
   * 图标优先级：应用图标文件（resize 16×16，清晰可见）→ 内嵌 data URL。
   * 内嵌 16×16 PNG 在 Windows 高 DPI 下几乎不可见，是「托盘中找不到图标」的主因。
   */
  const createTray = (): void => {
    if (!electron.Tray || !electron.nativeImage || tray) return;
    let image: ElectronImageLike | null = null;
    try {
      if (iconPath && fs.existsSync(iconPath) && electron.nativeImage.createFromPath) {
        const loaded = electron.nativeImage.createFromPath(iconPath);
        if (!loaded.isEmpty?.()) image = loaded;
      }
    } catch {
      /* 应用图标缺失/损坏 → 回退内嵌 */
    }
    try {
      const base =
        image ??
        electron.nativeImage.createFromDataURL(opts.trayIconDataUrl ?? DEFAULT_TRAY_ICON_DATA_URL);
      // Windows 托盘图标标准尺寸 16×16；高分屏下 Electron 会自动适配 DPI。
      const t = new electron.Tray(base.resize({ width: 16, height: 16 }));
      t.setToolTip('Mozi — 墨子编码 Agent');
      t.setContextMenu(
        electron.Menu.buildFromTemplate([
          { label: '显示 Mozi 主窗口', click: () => showMainWindow() },
          { type: 'separator' },
          {
            label: '退出 Mozi',
            click: () => {
              isQuitting = true;
              electron.app.quit();
            },
          },
        ]),
      );
      // 单击托盘恢复主窗口。
      t.on('click', () => showMainWindow());
      tray = t;
    } catch {
      /* 托盘创建失败（如 Linux 无系统托盘）：不阻塞启动，退出走 app.quit */
    }
  };

  const shutdown = async (): Promise<void> => {
    tasksHost.stop();
    await service.shutdown(10_000); // 全部会话 flush + abort（10s 上限）
  };

  electron.app.on('before-quit', () => {
    isQuitting = true; // 放行窗口 close 拦截，真正退出。
    void shutdown();
  });
  electron.app.on('window-all-closed', () => {
    // macOS 保留应用存活（惯例）；其他平台按关闭行为决定是否退出。
    if (process.platform === 'darwin') return;
    // 托盘模式且托盘已就绪 → 窗口全部关闭也常驻（通常被 hide 拦截，此处为兜底）。
    if (settings.closeBehavior() === 'tray' && tray) return;
    // 直接退出模式（或托盘不可用）：全部窗口关闭即退出应用。
    electron.app.quit();
  });

  // 启动即创建托盘（切换到「关闭到托盘」后立即可见）；创建失败不阻塞。
  createTray();
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

export { DiffReviewService, SettingsStore, McpManager, AgentService, IpcBridge, BrowserRegistry };
