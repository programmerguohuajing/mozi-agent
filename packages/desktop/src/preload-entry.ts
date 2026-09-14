/**
 * preload 运行期入口（M10 §10.2 进程安全）。
 *
 * `preload.ts` 只导出 `installPreload()`（为便于单测），**仓库内没有任何地方调用它** ——
 * 如果直接把它当作 Electron 的 preload 脚本，`window.mozi` 永远不会被注入，
 * 渲染进程会一直停在「请在 Electron 中运行」的提示页。本文件是真正被 Electron
 * 加载的入口：取到运行期 electron 后立即安装白名单 API。
 *
 * 窗口使用 `sandbox: true`（见 electron-main.ts），因此本文件必须被打包为
 * **单文件 CommonJS**（见 scripts/bundle.mjs），运行期只依赖 `require('electron')`。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { installPreload, type PreloadElectron } from './preload.js';

const electron = {
  contextBridge,
  ipcRenderer,
  process: { versions: { ...process.versions } },
} as unknown as PreloadElectron;

installPreload(electron);
