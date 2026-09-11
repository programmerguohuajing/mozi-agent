import { defineConfig } from 'vitest/config';

// 内置 Git 工具测试在本机 Windows 上 git init/commit 单次约 12–17s，
// 超过 vitest 默认 5s 超时；这里把单测/钩子超时提到 30s。
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
