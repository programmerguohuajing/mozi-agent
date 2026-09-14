/**
 * 构建可安装的桌面端安装包（Windows NSIS / macOS DMG）。
 *
 * 流程：
 *   1. 预检      —— 确认 @mozi/* 已构建（esbuild 需要它们的 dist）。
 *   2. 渲染进程  —— vite build -> packages/desktop/dist/renderer。
 *   3. 运行期产物 —— esbuild 打包主进程 / preload（见 bundle.mjs）。
 *   4. 暂存目录  —— 把 dist + build/icon.* + 精简 package.json 组装到
 *                   .build/package-stage（不含 node_modules / workspace 依赖）。
 *   5. 打安装包  —— electron-builder 产出安装程序到 packages/desktop/release。
 *
 * 为什么要「暂存目录」而不是直接在 packages/desktop 上打包：
 *   - 工作区依赖是 `workspace:*` 协议，electron-builder 解析生产依赖树时会报错；
 *   - 运行期产物已经自包含（主进程/preload 全打包），安装包内不需要任何 node_modules；
 *   - 隔离后 packages/desktop 的源码/类型/新依赖都不会意外进入安装包。
 *
 * 用法：
 *   node scripts/package.mjs              # 产出 Windows NSIS 安装包（x64）
 *   node scripts/package.mjs --dir        # 只产出 win-unpacked（跳过 NSIS，便于自检）
 *   node scripts/package.mjs --skip-renderer
 *
 *   node scripts/package.mjs --mac               # 产出 macOS DMG（x64 + arm64）
 *   node scripts/package.mjs --mac --arch x64    # 仅 Intel
 *   node scripts/package.mjs --mac --arch arm64  # 仅 Apple Silicon
 *   node scripts/package.mjs --mac --dir         # 只产出 mac-unpacked
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
const BUILD_MAC = argv.includes('--mac');

// 解析 --arch 参数（仅 Mac 模式生效）
let MAC_ARCH = null; // null = 双架构
const archIdx = argv.indexOf('--arch');
if (archIdx !== -1 && archIdx + 1 < argv.length) {
  MAC_ARCH = argv[archIdx + 1];
  if (MAC_ARCH !== 'x64' && MAC_ARCH !== 'arm64') {
    console.error(`[package] 无效的 --arch 值: ${MAC_ARCH}（仅支持 x64 / arm64）`);
    process.exit(1);
  }
}

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

  // Mac 构建还需要 icon.icns（如果有的话）
  const icnsPath = path.join(DESKTOP_DIR, 'build', 'icon.icns');
  if (fs.existsSync(icnsPath)) {
    copies.push(['build/icon.icns', 'build/icon.icns']);
  }

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

/**
 * 5. electron-builder。
 *
 * Windows: 产出 NSIS 安装包（x64）。
 * macOS:   产出 DMG 安装包（x64 + arm64 或指定单一架构）。
 *          macOS 构建需要在 macOS 环境运行（或 CI runner），
 *          electron-builder 会自动下载对应架构的 Electron 二进制。
 */
async function runBuilder(staged) {
  const eb = require(resolveTool('electron-builder'));
  const { stageDir, buildConfig } = staged;

  if (BUILD_MAC) {
    return runMacBuilder(eb, stageDir, buildConfig);
  }
  return runWinBuilder(eb, stageDir, buildConfig);
}

/** Windows NSIS 打包。 */
async function runWinBuilder(eb, stageDir, buildConfig) {
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

/** macOS DMG 打包（Intel x64 + Apple Silicon arm64）。 */
async function runMacBuilder(eb, stageDir, buildConfig) {
  // macOS 构建需要在 macOS 上运行
  if (process.platform !== 'darwin') {
    log('⚠ 当前非 macOS 环境，electron-builder 将尝试交叉构建。');
    log('  若失败请在 macOS 机器或 CI runner 上运行：node scripts/package.mjs --mac');
  }

  // 确定架构
  const archs = MAC_ARCH ? [MAC_ARCH] : ['x64', 'arm64'];
  const archLabel = archs.join(' + ');
  log(`构建 macOS DMG 安装包（${archLabel}）…`);

  const macConfig = {
    ...buildConfig,
    mac: {
      ...(buildConfig.mac ?? {}),
      icon: fs.existsSync(path.join(stageDir, 'build', 'icon.icns'))
        ? 'build/icon.icns'
        : 'build/icon.png',
      target: DIR_ONLY
        ? [{ target: 'dir', arch: archs }]
        : [{ target: 'dmg', arch: archs }],
      // artifactName 由 package.json build.mac.artifactName 提供（${productName}-${version}-${arch}.${ext}）
      category: 'public.app-category.developer-tools',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      // 无代码签名时仍可产出（开发/内部分发）
      identity: null,
    },
    // macOS 不需要 electronDist（让 electron-builder 自动下载对应架构）
    npmRebuild: false,
    nodeGypRebuild: false,
    directories: {
      output: RELEASE_DIR,
      buildResources: path.join(stageDir, 'build'),
    },
  };

  const targets = DIR_ONLY
    ? eb.Platform.MAC.createTarget('dir', ...archs.map((a) => eb.Arch[a]))
    : eb.Platform.MAC.createTarget(['dmg'], ...archs.map((a) => eb.Arch[a]));

  await eb.build({
    projectDir: stageDir,
    targets,
    publish: 'never',
    config: macConfig,
  });
}

function report() {
  log(`产物目录: ${path.relative(REPO_ROOT, RELEASE_DIR)}`);
  if (!fs.existsSync(RELEASE_DIR)) return;
  for (const entry of fs.readdirSync(RELEASE_DIR)) {
    const full = path.join(RELEASE_DIR, entry);
    if (fs.statSync(full).isFile() && /\.(exe|dmg)$/i.test(entry)) {
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
