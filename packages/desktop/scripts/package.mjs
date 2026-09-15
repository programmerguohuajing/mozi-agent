import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
/**
 * 构建可安装的桌面端安装包（Windows NSIS / macOS DMG / Linux AppImage）。
 *
 * 流程：
 *   1. 预检      —— 确认 @mozi/* 已构建（esbuild 需要它们的 dist）。
 *   2. 渲染进程  —— vite build -> packages/desktop/dist/renderer。
 *   3. 运行期产物 —— esbuild 打包主进程 / preload（见 bundle.mjs），按目标平台条件编译。
 *   4. 暂存目录  —— 只复制目标平台的资源（图标等），组装到 .build/package-stage。
 *   5. 打安装包  —— electron-builder 产出安装程序到 packages/desktop/release。
 *
 * 平台资源隔离：
 *   - Windows: 只复制 icon.ico（+ icon.png 作通用回退）
 *   - macOS:   只复制 icon.icns（若有，否则 icon.png）
 *   - Linux:   只复制 icon.png
 *   - 暂存 package.json 中 files 数组按平台动态裁剪，确保 asar 内不含其他平台资源
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
 *
 *   node scripts/package.mjs --linux             # 产出 Linux AppImage（x64）
 *   node scripts/package.mjs --linux --dir       # 只产出 linux-unpacked
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, resolvePackageDir, resolveTool } from './bundle.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
// 产物目录：固定使用 packages/desktop/release，每次构建前自动清理。
// MOZI_RELEASE_DIR 仍可用于特殊场景覆盖。
const DEFAULT_RELEASE_DIR = path.join(DESKTOP_DIR, 'release');
const RELEASE_DIR = process.env.MOZI_RELEASE_DIR
  ? path.resolve(process.env.MOZI_RELEASE_DIR)
  : DEFAULT_RELEASE_DIR;

/**
 * 构建前清理产物目录，避免版本文件夹堆积。
 * 如果旧目录被占用无法删除，则重命名到 _trash 后继续构建。
 */
function cleanReleaseDir() {
  if (!fs.existsSync(RELEASE_DIR)) return;
  try {
    fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
    return;
  } catch {
    // 旧目录被占用（如 app.asar 被运行中的进程锁住），尝试重命名后让构建继续
  }
  const trashName = `${RELEASE_DIR}._trash_${Date.now()}`;
  try {
    fs.renameSync(RELEASE_DIR, trashName);
    log(`旧产物目录被占用，已重命名到 ${path.basename(trashName)}（可手动删除）`);
    // 尝试异步删除（可能仍失败，但不阻塞构建）
    setTimeout(() => {
      try {
        fs.rmSync(trashName, { recursive: true, force: true });
      } catch {
        /* 留给用户手动删 */
      }
    }, 5000);
  } catch {
    // 重命名也失败，只能提示用户
    log('⚠ 无法清理旧产物目录（文件被占用），请关闭运行中的 Mozi 后重试');
    throw new Error(`无法清理 ${RELEASE_DIR}：文件被占用，请先关闭运行中的 Mozi`);
  }
}

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
const BUILD_LINUX = argv.includes('--linux');

// 确定目标平台与 electron-builder 平台标识
const TARGET_PLATFORM = BUILD_MAC ? 'darwin' : BUILD_LINUX ? 'linux' : 'win32';
const TARGET_LABEL = BUILD_MAC ? 'macOS' : BUILD_LINUX ? 'Linux' : 'Windows';

// 解析 --arch 参数
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
      `缺少已构建的工作区包: ${missing.join(', ')}\n请先构建（逐包 tsc，勿用 tsc -b tsconfig.base.json）：\n${required.map((n) => `  tsc -p packages/${n}/tsconfig.json`).join('\n')}`,
    );
  }
  log(`preflight OK — 目标平台: ${TARGET_LABEL}，工作区 dist 就绪`);
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

/**
 * 3+4. 组装暂存目录 —— 按目标平台只复制本平台所需资源。
 *
 * 平台资源隔离矩阵：
 *   win32:  icon.ico + icon.png   （ico 用于 exe/dll 图标，png 用于 asar 内通用资源）
 *   darwin: icon.icns（若有）+ icon.png（若无 icns 则 png 充当 mac 图标）
 *   linux:  icon.png
 */
function stage() {
  // ── 通用产物（所有平台都需要）──
  const copies = [
    ['dist/main/index.cjs', 'dist/main/index.cjs'],
    ['dist/preload.cjs', 'dist/preload.cjs'],
    ['dist/renderer', 'dist/renderer'],
    ['dist/prompts', 'dist/prompts'],
  ];

  // ── 平台特定图标资源 ──
  const iconIco = path.join(DESKTOP_DIR, 'build', 'icon.ico');
  const iconIcns = path.join(DESKTOP_DIR, 'build', 'icon.icns');
  const iconPng = path.join(DESKTOP_DIR, 'build', 'icon.png');

  if (TARGET_PLATFORM === 'win32') {
    // Windows: 需要 ico（exe 图标）+ png（asar 内通用）
    copies.push(['build/icon.ico', 'build/icon.ico']);
    copies.push(['build/icon.png', 'build/icon.png']);
  } else if (TARGET_PLATFORM === 'darwin') {
    // macOS: 优先 icns，回退 png；不复制 ico
    if (fs.existsSync(iconIcns)) {
      copies.push(['build/icon.icns', 'build/icon.icns']);
    }
    copies.push(['build/icon.png', 'build/icon.png']);
  } else {
    // Linux: 只需 png
    copies.push(['build/icon.png', 'build/icon.png']);
  }

  const stageDir = freshStageDir();
  for (const [from, to] of copies) {
    const src = path.join(DESKTOP_DIR, from);
    if (!fs.existsSync(src))
      throw new Error(`暂存失败：缺少 ${from}（请先运行 bundle / build:renderer）`);
    const dest = path.join(stageDir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }

  // ── 按平台裁剪 files 数组（控制 asar 内容）──
  const baseFiles = [
    'dist/main/index.cjs',
    'dist/preload.cjs',
    'dist/renderer/**/*',
    'dist/prompts/**/*',
    'package.json',
  ];

  const platformFiles = {
    win32: [...baseFiles, 'build/icon.ico', 'build/icon.png'],
    darwin: [
      ...baseFiles,
      fs.existsSync(iconIcns) ? 'build/icon.icns' : 'build/icon.png',
      'build/icon.png',
    ],
    linux: [...baseFiles, 'build/icon.png'],
  };

  const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  // 安装包版本取桌面包版本；若为占位的 0.0.0 则退回仓库根版本。
  const version =
    desktopPkg.version && desktopPkg.version !== '0.0.0' ? desktopPkg.version : rootPkg.version;

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

  log(`暂存完成 -> ${path.relative(REPO_ROOT, stageDir)} (v${version}, ${TARGET_LABEL})`);
  return {
    stageDir,
    version,
    buildConfig: desktopPkg.build ?? {},
    platformFiles: platformFiles[TARGET_PLATFORM],
  };
}

/**
 * 5. electron-builder —— 按目标平台选择构建器。
 *
 * Windows: 产出 NSIS 安装包（x64）。
 * macOS:   产出 DMG 安装包（x64 + arm64 或指定单一架构）。
 *          macOS 构建需要在 macOS 环境运行（或 CI runner），
 *          electron-builder 会自动下载对应架构的 Electron 二进制。
 * Linux:   产出 AppImage（x64）。
 */
async function runBuilder(staged) {
  const eb = require(resolveTool('electron-builder'));
  const { stageDir, buildConfig, platformFiles } = staged;

  if (BUILD_MAC) {
    return runMacBuilder(eb, stageDir, buildConfig, platformFiles);
  }
  if (BUILD_LINUX) {
    return runLinuxBuilder(eb, stageDir, buildConfig, platformFiles);
  }
  return runWinBuilder(eb, stageDir, buildConfig, platformFiles);
}

/** Windows NSIS 打包。 */
async function runWinBuilder(eb, stageDir, buildConfig, platformFiles) {
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
      // 按平台裁剪 asar 内容：只含 Windows 资源
      files: platformFiles,
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
async function runMacBuilder(eb, stageDir, buildConfig, platformFiles) {
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
    // 按平台裁剪 asar 内容：只含 macOS 资源
    files: platformFiles,
    mac: {
      ...(buildConfig.mac ?? {}),
      icon: fs.existsSync(path.join(stageDir, 'build', 'icon.icns'))
        ? 'build/icon.icns'
        : 'build/icon.png',
      target: DIR_ONLY ? [{ target: 'dir', arch: archs }] : [{ target: 'dmg', arch: archs }],
      // artifactName 由 package.json build.mac.artifactName 提供
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

/** Linux AppImage 打包（x64）。 */
async function runLinuxBuilder(eb, stageDir, buildConfig, platformFiles) {
  if (process.platform === 'win32') {
    log('⚠ 当前为 Windows 环境，Linux 构建可能需要 Docker 或 CI runner。');
    log('  建议在 Linux 机器上运行：node scripts/package.mjs --linux');
  }

  log('构建 Linux AppImage（x64）…');

  const linuxConfig = {
    ...buildConfig,
    // 按平台裁剪 asar 内容：只含 Linux 资源
    files: platformFiles,
    linux: {
      ...(buildConfig.linux ?? {}),
      icon: 'build/icon.png',
      target: DIR_ONLY
        ? [{ target: 'dir', arch: ['x64'] }]
        : [{ target: 'AppImage', arch: ['x64'] }],
      artifactName: '${productName}-${version}-${arch}.${ext}',
      category: 'Development',
    },
    npmRebuild: false,
    nodeGypRebuild: false,
    directories: {
      output: RELEASE_DIR,
      buildResources: path.join(stageDir, 'build'),
    },
  };

  const targets = DIR_ONLY
    ? eb.Platform.LINUX.createTarget('dir', eb.Arch.x64)
    : eb.Platform.LINUX.createTarget(['AppImage'], eb.Arch.x64);

  await eb.build({
    projectDir: stageDir,
    targets,
    publish: 'never',
    config: linuxConfig,
  });
}

function report() {
  log(`产物目录: ${path.relative(REPO_ROOT, RELEASE_DIR)}`);
  if (!fs.existsSync(RELEASE_DIR)) return;
  for (const entry of fs.readdirSync(RELEASE_DIR)) {
    const full = path.join(RELEASE_DIR, entry);
    if (fs.statSync(full).isFile() && /\.(exe|dmg|AppImage)$/i.test(entry)) {
      log(`  ${entry}  (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

async function main() {
  cleanReleaseDir();
  preflight();
  buildRenderer();
  // 按目标平台条件编译（esbuild conditions）
  log(`esbuild 条件编译 (platform:${TARGET_PLATFORM})…`);
  await bundle({ targetPlatform: TARGET_PLATFORM });
  const staged = stage();
  await runBuilder(staged);
  report();
}

main().catch((err) => {
  console.error('[package] FAILED:', err?.stack ? err.stack : err);
  process.exit(1);
});
