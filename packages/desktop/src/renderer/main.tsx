/**
 * 渲染进程入口（Vite）。
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App, type MoziApi } from './App.js';

const api = window.mozi;
const el = document.getElementById('root');
if (!api) {
  // 非 Electron 环境（浏览器直开）：给出明确提示。
  if (el) el.textContent = '请在 Electron 中运行（window.mozi 不可用）。';
} else if (el) {
  createRoot(el).render(React.createElement(App, { api }));
}

export type { MoziApi };
