import { defineConfig } from 'vitest/config';

/**
 * 桌面包测试配置。
 * 独立于 `vite.config.ts`（后者用于渲染进程构建，依赖未安装的 vite/electron）。
 * 测试只覆盖传输无关的主进程核心 + 渲染进程纯逻辑（store/render-item/diff 模型）。
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
