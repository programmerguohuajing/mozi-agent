/**
 * Electron IPC 传输适配器（§10.3 / §14.3）。
 *
 * 把 §10.3 的 channel 清单映射到 Electron 的 `ipcMain.handle` / `webContents.send`。
 * **这是唯一依赖 `electron` 的模块之一**，因此运行时验证走 `LoopbackChannel`
 * （见 `packages/protocol/src/loopback.ts`），本文件仅做薄映射。
 *
 * 安全（§10.2）：Renderer 一律 `contextIsolation: true` + `nodeIntegration: false`；
 * 所有 Node 能力通过 preload 暴露的白名单 API（`window.mozi.*`）。
 */
import type {
  ChannelServer,
  InvokeChannel,
  MaybePromise,
  SendChannel,
  SendChannelMap,
} from '@mozi/protocol';

/** Electron `ipcMain` / `webContents` 的最小契约（避免静态依赖 electron 类型）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
  removeHandler?(channel: string): void;
}

export interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

/** invoke 通道统一加前缀，避免与其他应用的 IPC 冲突。 */
export const IPC_PREFIX = 'mozi:';

export function ipcChannelName(channel: InvokeChannel | SendChannel): string {
  return `${IPC_PREFIX}${channel}`;
}

/**
 * 主进程侧传输：`handle` → `ipcMain.handle`；`send` → `webContents.send`。
 * 支持多窗口：`targets()` 返回需要接收事件的 webContents 列表。
 */
export class ElectronChannelServer implements ChannelServer {
  private readonly handlers = new Map<string, (payload: unknown) => unknown>();

  constructor(
    private readonly ipcMain: IpcMainLike,
    private readonly targets: () => WebContentsLike[],
  ) {}

  handle<C extends InvokeChannel>(
    channel: C,
    handler: (payload: never) => MaybePromise<unknown>,
  ): void {
    const name = ipcChannelName(channel);
    this.handlers.set(name, handler as (payload: unknown) => unknown);
    this.ipcMain.handle(name, (_event, payload) => {
      const fn = this.handlers.get(name);
      if (!fn) throw new Error(`no handler for channel: ${channel}`);
      return fn(payload);
    });
  }

  send<C extends SendChannel>(channel: C, payload: SendChannelMap[C]): void {
    const name = ipcChannelName(channel);
    for (const wc of this.targets()) {
      try {
        if (wc.isDestroyed?.()) continue;
        wc.send(name, payload);
      } catch {
        /* 窗口已销毁：跳过（窗口关闭 ≠ 会话销毁，§10.4） */
      }
    }
  }

  /** 已注册的通道名（诊断）。 */
  handledChannels(): string[] {
    return [...this.handlers.keys()];
  }
}

/**
 * preload 侧暴露的白名单 API 形状（§10.2）。
 * preload 通过 `contextBridge.exposeInMainWorld('mozi', ...)` 注入。
 */
export interface MoziPreloadApi {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** 版本信息（关于面板）。 */
  versions: { app: string; electron: string; node: string; chrome: string };
}

/** 允许渲染进程调用的通道白名单（防越权调用，§10.2 进程安全）。 */
export const ALLOWED_INVOKE: InvokeChannel[] = [
  'session:create',
  'session:resume',
  'session:fork',
  'session:list',
  'session:delete',
  'run:start',
  'approval:resolve',
  'engine:abort',
  'config:get',
  'config:set',
  'config:listProviders',
  'config:testProvider',
  'mcp:list',
  'mcp:add',
  'mcp:remove',
  'mcp:restart',
  'audit:query',
  'dashboard:stats',
  'diff:applyPartial',
  'browser:capture',
  'browser:saveAnnotated',
];

export const ALLOWED_SEND: SendChannel[] = [
  'engine:event',
  'session:status',
  'updater:status',
  'updater:download-progress',
];

/**
 * preload 的 invoke 转发实现（不含 electron 引用，便于单测）。
 * `rawInvoke` 由 preload 注入 `ipcRenderer.invoke`。
 */
export function createPreloadInvoker(
  rawInvoke: (channel: string, payload: unknown) => Promise<unknown>,
): (channel: string, payload: unknown) => Promise<unknown> {
  const allow = new Set<string>(ALLOWED_INVOKE.map(ipcChannelName));
  return (channel, payload) => {
    if (!allow.has(channel)) {
      return Promise.reject(new Error(`channel not allowed: ${channel}`));
    }
    return rawInvoke(channel, payload);
  };
}

/** preload 的事件订阅实现（channel 白名单校验 + 退订）。 */
export function createPreloadSubscriber(
  rawOn: (channel: string, listener: (payload: unknown) => void) => () => void,
): (channel: string, listener: (payload: unknown) => void) => () => void {
  const allow = new Set<string>(ALLOWED_SEND.map(ipcChannelName));
  return (channel, listener) => {
    if (!allow.has(channel)) {
      throw new Error(`channel not allowed: ${channel}`);
    }
    return rawOn(channel, listener);
  };
}
