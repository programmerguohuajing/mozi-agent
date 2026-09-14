/**
 * 构建可安装的桌面端安装包（Windows NSIS）。
 *
 * 流程：
 *   1. 预检      —— 确认 @mozi/* 已构建（esbuild 需要它们的 dist）。
 *   2. 渲染进程  —— vite build -> packages/desktop/dist/renderer。
 *   3. 运行期产物 —— esbuild 打包主进程 / preload（见 bundle.mjs）。
 *   4. 暂存目录  —— 把 dist + build/icon.* + 精简 package.json 组装到
 *                   .build/package-stage（不含 node_modules / workspace 依赖）。
 *   5. 打安装包  —— electron-builder 产出 NSIS 安装程序到 packages/desktop/release。
 *
 * 为什么要「暂存目录」而不是直接在 packages/desktop 上打包：
 *   - 工作区依赖是 `workspace:*` 协议，electron-builder 解析生产依赖树时会报错；
 *   - 运行期产物已经自包含（主进程/preload 全打包），安装包内不需要任何 node_modules；
 *   - 隔离后 packages/desktop 的源码/类型/新依赖都不会意外进入安装包。
 *
 * 用法：
 *   node scripts/package.mjs          # 产出 NSIS 安装包 + win-unpacked
 *   node scripts/package.mjs --dir    # 只产出 win-unpacked（跳过 NSIS，便于自检）
 *   node scripts/package.mjs --skip-renderer
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bundle, resolveTool, resolvePackageDir } from './bundle.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
// 允许用 MOZI_RELEASE_DIR 指定产物目录（便于在受限环境里输出到全新目录，
// 避免 electron-builder 清空既有目录时的批量删除限制）。
const RELEASE_DIR = process.env.MOZI_RELEASE_DIR
  ? path.resolve(process.env.MOZI_RELEASE_DIR)
  : path.join(DESKTOP_DIR, 'release');

/**
 * 取一个干净的暂存目录。优先复用固定路径（便于排查）；
 * 若清理被环境限制（如批量删除守卫）则退化为全新目录，避免依赖删除操作。
 */
function freshStageDir() {
  const base = path.join(REPO_ROOT, '.build', 'package-stage');
  try {
    fs.rmSync(base, { recursive: true, force: true });
    return base;
  } catch {
    return path.join(REPO_ROOT, '.build', `package-stage-${Date.now()}`);
  }
}

const argv = process.argv.slice(2);
const DIR_ONLY = argv.includes('--dir');
const SKIP_RENDERER = argv.includes('--skip-renderer');

const log = (msg) => console.log(`[package] ${msg}`);

/** 1. 预检：工作区包必须已构建（esbuild 别名指向它们的 dist/index.js）。 */
function preflight() {
  const pkgsDir = path.join(REPO_ROOT, 'packages');
  const required = ['shared', 'core', 'protocol', 'tools', 'providers'];
  const missing = required.filter(
    (name) => !fs.existsSync(path.join(pkgsDir, name, 'dist', 'index.js')),
  );
  if (missing.length > 0) {
    throw new Error(
      `缺少已构建的工作区包: ${missing.join(', ')}\n` +
        `请先构建（逐包 tsc，勿用 tsc -b tsconfig.base.json）：\n` +
        required.map((n) => `  tsc -p packages/${n}/tsconfig.json`).join('\n'),
    );
  }
  log('preflight OK — 工作区 dist 就绪');
}

/** 2. 渲染进程构建（vite）。 */
function buildRenderer() {
  if (SKIP_RENDERER) {
    log('跳过渲染进程构建（--skip-renderer）');
    return;
  }
  const viteBin = path.join(resolvePackageDir('vite'), 'bin', 'vite.js');
  const config = path.join(DESKTOP_DIR, 'vite.config.ts');
  log('构建渲染进程 (vite build)…');
  execFileSync(process.execPath, [viteBin, 'build', '--config', config], {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
  });
}

/** 3+4. 组装暂存目录。 */
function stage() {
  const copies = [
    ['dist/main/index.cjs', 'dist/main/index.cjs'],
    ['dist/preload.cjs', 'dist/preload.cjs'],
    ['dist/renderer', 'dist/renderer'],
    ['build/icon.png', 'build/icon.png'],
    ['build/icon.ico', 'build/icon.ico'],
  ];

  const stageDir = freshStageDir();
  for (const [from, to] of copies) {
    const src = path.join(DESKTOP_DIR, from);
    if (!fs.existsSync(src)) throw new Error(`暂存失败：缺少 ${from}（请先运行 bundle / build:renderer）`);
    const dest = path.join(stageDir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }

  const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  // 安装包版本取桌面包版本；若为占位的 0.0.0 则退回仓库根版本。
  const version = desktopPkg.version && desktopPkg.version !== '0.0.0' ? desktopPkg.version : rootPkg.version;

  const stagedManifest = {
    name: 'mozi',
    productName: desktopPkg.build?.productName ?? 'Mozi',
    version,
    description: rootPkg.description ?? desktopPkg.description,
    author: { name: 'Mozi' },
    license: desktopPkg.license ?? 'MIT',
    // 运行期产物自包含：安装包内不需要任何 node_modules。
    main: 'dist/main/index.cjs',
  };
  fs.writeFileSync(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
    'utf8',
  );

  log(`暂存完成 -> ${path.relative(REPO_ROOT, stageDir)} (v${version})`);
  return { stageDir, version, buildConfig: desktopPkg.build ?? {} };
}

/** 5. electron-builder。 */
async function runBuilder(staged) {
  const eb = require(resolveTool('electron-builder'));
  const { stageDir, buildConfig } = staged;
  const electronDist = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
    throw new Error(`未找到本地 Electron 运行时：${electronDist}`);
  }

  const targets = DIR_ONLY
    ? eb.Platform.WINDOWS.createTarget('dir', eb.Arch.x64)
    : eb.Platform.WINDOWS.createTarget(['nsis'], eb.Arch.x64);

  log(DIR_ONLY ? '产出未打包目录 (win-unpacked)…' : '构建 NSIS 安装包…');

  await eb.build({
    projectDir: stageDir,
    targets,
    publish: 'never',
    config: {
      ...buildConfig,
      // 复用本地已下载的 Electron，避免联网重新下载。
      electronDist,
      npmRebuild: false,
      nodeGypRebuild: false,
      directories: {
        output: RELEASE_DIR,
        buildResources: path.join(stageDir, 'build'),
      },
    },
  });
}

function report() {
  log(`产物目录: ${path.relative(REPO_ROOT, RELEASE_DIR)}`);
  if (!fs.existsSync(RELEASE_DIR)) return;
  for (const entry of fs.readdirSync(RELEASE_DIR)) {
    const full = path.join(RELEASE_DIR, entry);
    if (fs.statSync(full).isFile() && entry.endsWith('.exe')) {
      log(`  ${entry}  (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

async function main() {
  preflight();
  buildRenderer();
  await bundle();
  const staged = stage();
  await runBuilder(staged);
  report();
}

main().catch((err) => {
  console.error('[package] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
