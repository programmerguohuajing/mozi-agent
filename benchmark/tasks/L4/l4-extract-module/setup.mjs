// 初始化评测仓库：node setup.mjs <workspace>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');
mkdirSync(join(dir, 'lib'), { recursive: true });

writeFileSync(
  join(dir, 'lib', 'everything.js'),
  `// ---- 领域 1：格式化 ----
const pad = (n) => String(n).padStart(2, '0');

export function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function formatMoney(cents, currency = 'CNY') {
  return (cents / 100).toFixed(2) + ' ' + currency;
}

// ---- 领域 2：HTTP（模拟） ----
export async function httpGet(url) {
  return { method: 'GET', url };
}

export async function httpPost(url, body) {
  return { method: 'POST', url, body };
}

// ---- 领域 3：存储（内存模拟） ----
const store = new Map();

export function save(key, value) {
  store.set(key, value);
  return true;
}

export function load(key) {
  return store.get(key);
}

// TODO: 三个领域互不相关，请拆成 lib/format.js / lib/http.js / lib/storage.js，
//       everything.js 只保留 re-export（对外 API 不变）。
`,
);
