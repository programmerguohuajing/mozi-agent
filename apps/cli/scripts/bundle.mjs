/**
 * CLI npm 发布打包脚本（esbuild）。
 *
 * 把 apps/cli/src/index.ts 连同所有 @mozi/* 工作区依赖与 commander 打包成
 * 单一自包含 ESM 产物 dist/index.js —— npm 安装后无需 node_modules 即可运行。
 *
 * 提示词资源（packages/core/src/prompts/*.md）复制到 dist/prompts/，
 * 运行期 PromptAssets 经 `__dirname/prompts` 候选路径定位（见 assets.ts）。
 *
 * 前置条件：先 `pnpm build`（确保各 packages/&lt;pkg&gt;/dist/index.js 存在）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(CLI_DIR, '..', '..');
const PNPM_STORE = path.join(REPO_ROOT, 'node_modules', '.pnpm');

/** 解析构建期工具（esbuild）：先试正常 node_modules，再退化到 pnpm store。 */
function resolveTool(name) {
  const bases = [CLI_DIR, REPO_ROOT];
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
  throw new Error(`[cli-bundle] 无法解析 ${name}，请先执行 pnpm install`);
}

/** 把每个 @mozi/<pkg> 别名到它自己的 dist 产物（tsc 已构建）。 */
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

/** 复制提示词资源到 dist/prompts（运行期 PromptAssets 按此路径加载）。 */
function copyPromptAssets(outDir) {
  const srcDir = path.join(REPO_ROOT, 'packages', 'core', 'src', 'prompts');
  const destDir = path.join(outDir, 'prompts');
  if (!fs.existsSync(path.join(srcDir, 'identity.md'))) {
    throw new Error(`[cli-bundle] 缺少提示词资源：${srcDir}/identity.md`);
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
  if (!fs.existsSync(path.join(destDir, 'identity.md'))) {
    throw new Error(`[cli-bundle] 提示词复制失败：${path.join(destDir, 'identity.md')} 不存在`);
  }
  console.log(`[cli-bundle] prompts -> ${path.relative(REPO_ROOT, destDir)} (${count} 个 .md)`);
}

async function bundle() {
  const esbuild = require(resolveTool('esbuild'));
  const alias = workspaceAliases();
  const outDir = path.join(CLI_DIR, 'dist');
  const outfile = path.join(outDir, 'index.cjs');
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    alias,
    entryPoints: [path.join(CLI_DIR, 'src', 'index.ts')],
    outfile,
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
    legalComments: 'none',
    sourcemap: false,
  });

  const code = fs.readFileSync(outfile, 'utf8');
  // 自检：不允许残留未打包的 @mozi/* 运行时依赖。
  const leftover = code.match(/require\(["']@mozi\/[a-z-]+["']\)|from\s+["']@mozi\/[a-z-]+["']/g);
  if (leftover) {
    throw new Error(`[cli-bundle] 仍有未打包的工作区依赖 ${leftover.join(', ')}`);
  }
  const kb = (Buffer.byteLength(code) / 1024).toFixed(1);
  console.log(`[cli-bundle] dist/index.cjs (${kb} kB)`);

  copyPromptAssets(outDir);
}

bundle().catch((err) => {
  console.error('[cli-bundle] FAILED:', err?.message ?? err);
  process.exit(1);
});
