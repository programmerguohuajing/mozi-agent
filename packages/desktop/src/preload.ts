/**
 * Electron preload（M10 §10.2 进程安全）。
 *
 * 在隔离上下文中通过 `contextBridge.exposeInMainWorld('mozi', ...)` 暴露白名单 API：
 *   - `window.mozi.invoke(channel, payload)`
 *   - `window.mozi.on(channel, listener)` → 返回退订函数
 *   - `window.mozi.versions`
 *
 * Renderer 无法直接访问 Node / ipcRenderer；通道白名单双端校验（此处 + 主进程）。
 * **运行时依赖 `electron`**，故用最小接口延迟绑定，保持可类型检查。
 */
import {
  ALLOWED_INVOKE,
  ALLOWED_SEND,
  createPreloadInvoker,
  createPreloadSubscriber,
  ipcChannelName,
} from './main/electron-transport.js';

/** electron preload 环境最小接口。 */
export interface PreloadElectron {
  contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
  ipcRenderer: {
    invoke(channel: string, payload: unknown): Promise<unknown>;
    on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  };
  process: { versions: Record<string, string> };
}

/** 构建 preload API（与 electron 解耦，便于单测）。 */
export function buildMoziApi(el: PreloadElectron): {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
  versions: { app: string; electron: string; node: string; chrome: string };
} {
  const invoke = createPreloadInvoker((channel, payload) => el.ipcRenderer.invoke(channel, payload));

  const rawOn = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    el.ipcRenderer.on(channel, wrapped);
    return () => el.ipcRenderer.removeListener(channel, wrapped);
  };
  const on = createPreloadSubscriber(rawOn);

  return {
    invoke,
    on,
    versions: {
      app: '0.0.0',
      electron: el.process.versions['electron'] ?? '',
      node: el.process.versions['node'] ?? '',
      chrome: el.process.versions['chrome'] ?? '',
    },
  };
}

/** preload 入口（由 Electron 调用；传 `require('electron')` 的结果）。 */
export function installPreload(el: PreloadElectron): void {
  const api = buildMoziApi(el);
  el.contextBridge.exposeInMainWorld('mozi', api);
}

export { ALLOWED_INVOKE, ALLOWED_SEND, ipcChannelName };
