/**
 * Electron 自启动引导（补全 M10：让 `pnpm electron` / `electron .` 真正拉起窗口）。
 *
 * `electron-main.ts` 只导出 `boot()`（传输无关、可在纯 Node 测试），本文件负责在
 * 运行期把 Electron 注入并启动它。为保持「无重依赖 + 可类型检查」的仓库约定，
 * 这里通过最小接口延迟绑定 electron，不依赖 electron 的类型副作用（electron 作为
 * optionalDependency 安装，类型可能离线缺失，故用 `as unknown as ElectronModule` 桥接）。
 */
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, type ElectronModule } from './electron-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 把运行期 electron 适配为 ElectronModule 最小接口。 */
const electron = {
  app,
  BrowserWindow,
  ipcMain,
  ...(safeStorage ? { safeStorage } : {}),
} as unknown as ElectronModule;

const rendererIndex = path.resolve(__dirname, '..', 'renderer', 'index.html');
const preloadPath = path.resolve(__dirname, '..', 'preload.js');
const iconPath = path.resolve(__dirname, '..', '..', 'build', 'icon.png');

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
