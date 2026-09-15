import fs from 'node:fs';
import path from 'node:path';
/**
 * Electron 自启动引导（补全 M10：让 `pnpm electron` / `electron .` 真正拉起窗口）。
 *
 * `electron-main.ts` 只导出 `boot()`（传输无关、可在纯 Node 测试），本文件负责在
 * 运行期把 Electron 注入并启动它。为保持「无重依赖 + 可类型检查」的仓库约定，
 * 这里通过最小接口延迟绑定 electron，不依赖 electron 的类型副作用（electron 作为
 * optionalDependency 安装，类型可能离线缺失，故用 `as unknown as ElectronModule` 桥接）。
 */
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  webContents,
} from 'electron';
import { type ElectronModule, boot } from './electron-main.js';

/** 把运行期 electron 适配为 ElectronModule 最小接口。 */
const electron = {
  app,
  BrowserWindow,
  Menu,
  // 系统托盘（§10.7）：漏注入会导致 closeBehavior='tray' 时托盘永远不创建。
  Tray,
  nativeImage,
  ipcMain,
  ...(safeStorage ? { safeStorage } : {}),
  // 输入栏"截图"按钮依赖屏幕捕获；缺失时桥接层会给出明确错误而非静默失败。
  ...(desktopCapturer ? { desktopCapturer } : {}),
  ...(screen ? { screen } : {}),
  // 新建任务时选择本地文件夹作为 workspace（原生目录选择框）。
  ...(dialog ? { dialog } : {}),
  // 任务浏览器面板：按 id 查找 <webview> 的 guest webContents（BrowserRegistry 接管）。
  ...(webContents ? { webContents } : {}),
} as unknown as ElectronModule;

// 资源路径一律以「应用根目录」为锚点解析：`electron .`（dev）与打包后
// （`resources/app.asar`）语义一致，且不依赖 __dirname / import.meta.url ——
// 因此可安全打包为 CommonJS（见 scripts/bundle.mjs），也便于 asar 内寻址。
const appRoot = app.getAppPath();
const rendererIndex = path.join(appRoot, 'dist', 'renderer', 'index.html');
const preloadPath = path.join(appRoot, 'dist', 'preload.cjs');
const iconPath = path.join(appRoot, 'build', 'icon.png');

boot({
  electron,
  rendererIndex,
  preloadPath,
  ...(fs.existsSync(iconPath) ? { iconPath } : {}),
}).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[mozi] failed to boot electron app:', err);
  process.exit(1);
});
