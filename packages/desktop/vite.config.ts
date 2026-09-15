import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * 渲染进程 Vite 配置（M10 §10.2）。
 * 开发时 `vite` 起 dev server（HMR），主进程用 devServerUrl loadURL；
 * 构建产物落 `dist/renderer`，主进程用 loadFile 加载。
 *
 * 注意：`vite` 未在本仓库安装（保持 `pnpm i` 干净）。安装后本配置即可生效。
 *
 * loadFile 使用 file:// 协议，需要：
 *   1. CSP 允许 file: 源（否则 ES Module 脚本被静默拦截 → 白屏）
 *   2. 移除 crossorigin 属性（file:// 无 CORS 响应头，crossorigin 导致加载失败）
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
  plugins: [
    {
      name: 'fix-file-protocol',
      transformIndexHtml(html) {
        // 移除 crossorigin 属性（file:// 协议下 CORS 模式加载会失败）
        let out = html.replace(/\s+crossorigin/g, '');
        // 放宽 CSP：允许 file: 源，确保 ES Module 脚本在 file:// 下可加载
        out = out.replace(
          /content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"/,
          'content="default-src \'self\' file:; script-src \'self\' \'unsafe-inline\' file:; style-src \'self\' \'unsafe-inline\' file:; img-src \'self\' data: file:; connect-src \'self\' ipc: https:;"',
        );
        return out;
      },
    },
  ],
  server: {
    port: 5273,
    strictPort: true,
  },
});
