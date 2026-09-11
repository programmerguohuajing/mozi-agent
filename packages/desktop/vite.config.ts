import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * 渲染进程 Vite 配置（M10 §10.2）。
 * 开发时 `vite` 起 dev server（HMR），主进程用 devServerUrl loadURL；
 * 构建产物落 `dist/renderer`，主进程用 loadFile 加载。
 *
 * 注意：`vite` 未在本仓库安装（保持 `pnpm i` 干净）。安装后本配置即可生效。
 */
export default defineConfig({
  root: __dirname,
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
  },
  resolve: {
    alias: {
      // 仅渲染层实际用到的运行时入口（LoopbackChannel）；其余均为类型，避免
      // 把 protocol 的 node:crypto 依赖（remote/crypto-box）拉进浏览器构建。
      '@mozi/protocol': path.resolve(__dirname, '../protocol/src/loopback.ts'),
      '@mozi/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
