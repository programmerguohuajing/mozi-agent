/**
 * Electron 自启动引导（补全 M10：让 `pnpm electron` / `electron .` 真正拉起窗口）。
 *
 * `electron-main.ts` 只导出 `boot()`（传输无关、可在纯 Node 测试），本文件负责在
 * 运行期把 Electron 注入并启动它。为保持「无重依赖 + 可类型检查」的仓库约定，
 * 这里通过最小接口延迟绑定 electron，不依赖 electron 的类型副作用（electron 作为
 * optionalDependency 安装，类型可能离线缺失，故用 `as unknown as ElectronModule` 桥接）。
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { boot, type ElectronModule } from './electron-main.js';

/** 把运行期 electron 适配为 ElectronModule 最小接口。 */
const electron = {
  app,
  BrowserWindow,
  ipcMain,
  ...(safeStorage ? { safeStorage } : {}),
  // 输入栏"截图"按钮依赖屏幕捕获；缺失时桥接层会给出明确错误而非静默失败。
  ...(desktopCapturer ? { desktopCapturer } : {}),
  ...(screen ? { screen } : {}),
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
