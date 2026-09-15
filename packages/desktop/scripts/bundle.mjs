import fs from 'node:fs';
/**
 * 桌面端「运行期产物」打包脚本（esbuild）。
 *
 *   src/main/bootstrap.ts  ->  dist/main/index.cjs    （Electron 主进程入口）
 *   src/preload-entry.ts   ->  dist/preload.cjs       （sandbox preload 入口）
 *
 * 为什么必须打包而不是只用 tsc：
 *   1. 窗口使用 `sandbox: true`，preload 必须是**单文件 CommonJS**，不能是 ESM，
 *      也不能在运行期解析 `@mozi/*` 工作区包（沙箱内没有 node_modules）。
 *   2. 主进程虽然要留在 Node 环境，但代码里 import 了 `@mozi/*`；打包后
 *      安装包内不再需要 node_modules，规避 pnpm 软链在 asar 中的解析问题。
 *
 * `electron` 保持 external（由运行期提供）；`@mozi/*` 别名到各自 dist 产物，
 * 因此不依赖 node_modules 的软链布局。
 *
 * 支持 --platform 参数按目标平台做条件编译：
 *   esbuild conditions 中注入 `platform:<win32|darwin|linux>`，
 *   源码中可用 `// #if platform:win32` 等条件导入做平台分支（可选）。
 *   process.platform 在运行期由 Electron 提供，保持运行时分支能力。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const PNPM_STORE = path.join(REPO_ROOT, 'node_modules', '.pnpm');
const PACK_TOOLS = path.join(REPO_ROOT, '.build', 'pack-tools');

/**
 * 解析构建期工具。优先走正常 node_modules（用户机器 pnpm install 后），
 * 再退化到本仓库的 pnpm store 与隔离工具目录（当前环境的实际布局）。
 */
export function resolveTool(name) {
  const bases = [DESKTOP_DIR, REPO_ROOT, PACK_TOOLS];
  if (fs.existsSync(PNPM_STORE)) {
    for (const dir of fs.readdirSync(PNPM_STORE)) {
      if (dir === name || dir.startsWith(`${name}@`)) {
        bases.push(path.join(PNPM_STORE, dir, 'node_modules'));
      }
    }
  }
  for (const base of bases) {
    try {
      return require.resolve(name, { paths: [base] });
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`[bundle] 无法解析 ${name}，请先执行 pnpm install（或确认 node_modules 完整）`);
}

/** 解析某个依赖的**包目录**（用于拿 CLI 入口，如 vite/bin/vite.js）。 */
export function resolvePackageDir(name) {
  const bases = [DESKTOP_DIR, REPO_ROOT, PACK_TOOLS];
  const dirs = [];
  for (const base of bases) dirs.push(path.join(base, 'node_modules', name));
  if (fs.existsSync(PNPM_STORE)) {
    for (const dir of fs.readdirSync(PNPM_STORE)) {
      if (dir === name || dir.startsWith(`${name}@`)) {
        dirs.push(path.join(PNPM_STORE, dir, 'node_modules', name));
      }
    }
  }
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(`[bundle] 无法定位包目录 ${name}，请先执行 pnpm install`);
}

/** 把每个 @mozi/<pkg> 别名到它自己的 dist 产物。 */
function workspaceAliases() {
  const alias = {};
  const pkgsDir = path.join(REPO_ROOT, 'packages');
  for (const name of fs.readdirSync(pkgsDir)) {
    const manifest = path.join(pkgsDir, name, 'package.json');
    const entry = path.join(pkgsDir, name, 'dist', 'index.js');
    if (fs.existsSync(manifest) && fs.existsSync(entry)) {
      alias[`@mozi/${name}`] = entry;
    }
  }
  return alias;
}

const BASE_OPTIONS = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
  legalComments: 'none',
};

/**
 * 复制提示词资源（packages/core/src/prompts/**.md）到运行期产物目录。
 *
 * 这些 `.md` 是运行期 `PromptAssets` 按文件路径读取的真源，但 tsc / esbuild 都只
 * 处理代码、不会自动带上它们 —— 漏掉这一步，打包后的应用一发送消息就会报
 * 「prompts 目录未找到（identity.md 缺失）」。目标 `<outDir>/prompts` 恰好落在
 * 打包后 `dist/main/index.cjs` 的 `__dirname/../prompts` = `dist/prompts` 候选路径上。
 */
export function copyPromptAssets(outDir) {
  const srcDir = path.join(REPO_ROOT, 'packages', 'core', 'src', 'prompts');
  const destDir = path.join(outDir, 'prompts');
  if (!fs.existsSync(path.join(srcDir, 'identity.md'))) {
    throw new Error(`[bundle] 缺少提示词资源：${srcDir}/identity.md`);
  }
  let count = 0;
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) walk(s, d);
      else if (entry.name.endsWith('.md')) {
        fs.copyFileSync(s, d);
        count += 1;
      }
    }
  };
  walk(srcDir, destDir);
  // 自检：目标目录必须真的含 identity.md，否则产物依旧不可用。
  if (!fs.existsSync(path.join(destDir, 'identity.md'))) {
    throw new Error(`[bundle] 提示词复制失败：${path.join(destDir, 'identity.md')} 不存在`);
  }
  console.log(`[bundle] prompts -> ${path.relative(REPO_ROOT, destDir)}  (${count} 个 .md)`);
}

/**
 * 按目标平台返回 esbuild conditions。
 *
 * 源码中可用条件导入做平台分支（可选），例如：
 *   import { screenshot } from './screenshot#platform:win32'
 * esbuild 会根据 conditions 选择对应平台实现，避免把其他平台的代码打进产物。
 *
 * 若源码中未使用条件导入，conditions 不影响正常构建。
 */
function platformConditions(targetPlatform) {
  if (!targetPlatform) return undefined;
  return [`platform:${targetPlatform}`];
}

/**
 * 打包运行期产物。
 * @param {object} [opts]
 * @param {string} [opts.targetPlatform] — 目标平台：'win32' | 'darwin' | 'linux'
 *        用于 esbuild conditions 条件编译，不影响 process.platform 运行时分支。
 */
export async function bundle(opts = {}) {
  const esbuild = require(resolveTool('esbuild'));
  const alias = workspaceAliases();
  const conditions = platformConditions(opts.targetPlatform);

  const targets = [
    {
      label: 'main',
      entry: path.join(DESKTOP_DIR, 'src', 'main', 'bootstrap.ts'),
      outfile: path.join(DESKTOP_DIR, 'dist', 'main', 'index.cjs'),
    },
    {
      label: 'preload',
      entry: path.join(DESKTOP_DIR, 'src', 'preload-entry.ts'),
      outfile: path.join(DESKTOP_DIR, 'dist', 'preload.cjs'),
    },
  ];

  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.outfile), { recursive: true });
    await esbuild.build({
      ...BASE_OPTIONS,
      alias,
      conditions,
      entryPoints: [t.entry],
      outfile: t.outfile,
    });

    const code = fs.readFileSync(t.outfile, 'utf8');
    // 自检 1：electron 必须是运行期 require，而非被打包进来。
    if (!/require\(["']electron["']\)/.test(code)) {
      throw new Error(`[bundle] ${t.label}: 未保留 require("electron")`);
    }
    // 自检 2：不允许残留未打包的 @mozi/* 运行时依赖。
    const leftover = code.match(/require\(["']@mozi\/[a-z-]+["']\)/g);
    if (leftover) {
      throw new Error(`[bundle] ${t.label}: 仍有未打包的工作区依赖 ${leftover.join(', ')}`);
    }
    // 自检 3：CJS 产物不得再出现 ESM 语法残留。
    if (/^\s*import\s|\bimport\.meta\b/m.test(code)) {
      throw new Error(`[bundle] ${t.label}: 产物中仍存在 ESM 语法`);
    }
    const kb = (Buffer.byteLength(code) / 1024).toFixed(1);
    console.log(
      `[bundle] ${t.label.padEnd(7)} -> ${path.relative(REPO_ROOT, t.outfile)}  (${kb} kB)`,
    );
  }

  // 资源：提示词 .md 必须随产物分发（tsc / esbuild 都不会自动带上）。
  copyPromptAssets(path.join(DESKTOP_DIR, 'dist'));

  return {
    main: path.join(DESKTOP_DIR, 'dist', 'main', 'index.cjs'),
    preload: path.join(DESKTOP_DIR, 'dist', 'preload.cjs'),
  };
}

// 允许 `node scripts/bundle.mjs` 直接执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 支持 --platform <win32|darwin|linux> 参数
  const argv = process.argv.slice(2);
  let targetPlatform = undefined;
  const pIdx = argv.indexOf('--platform');
  if (pIdx !== -1 && pIdx + 1 < argv.length) {
    targetPlatform = argv[pIdx + 1];
  }
  bundle({ targetPlatform }).catch((err) => {
    console.error('[bundle] FAILED:', err?.message ? err.message : err);
    process.exit(1);
  });
}
