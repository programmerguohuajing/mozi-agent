/**
 * @mozi/desktop —— Electron 桌面应用（主进程 + 渲染进程）。
 *
 * 本入口导出**主进程侧**的会话池、IPC 桥接、Diff 审阅、设置/密钥、MCP 管理等
 * 传输无关的核心（可在纯 Node 中测试）。Electron 外壳在 `src/main/electron-main.ts`
 * 与 `src/preload.ts`，渲染进程源码在 `src/renderer/`。
 */
export * from './main/agent-service.js';
export * from './main/ipc-bridge.js';
export * from './main/diff-service.js';
export * from './main/settings-store.js';
export * from './main/mcp-manager.js';
export * from './main/skill-scanner.js';
export * from './main/electron-transport.js';
export * from './main/browser-service.js';
export * from './main/browser-registry.js';
export * from './main/tasks-host.js';
export * from './preload.js';
export * from './shared/diff-types.js';
export * from './shared/diff-view.js';
export * from './shared/render-item.js';
export * from './shared/store.js';
export * from './shared/mentions.js';
