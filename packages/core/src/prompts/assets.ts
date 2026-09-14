/**
 * Prompt 资源加载（M15 §15.4）：`prompts/` 目录为提示词的版本化唯一真源
 * （git 管理，promptVersion = 目录内容 hash 前 8 位）。
 *
 * 加载器按候选路径依次探测：
 *   1. 显式注入的 promptsDir
 *   2. 模块目录相关的 prompts/（见下）
 *   3. Electron 的 process.resourcesPath/prompts（随应用分发的副本）
 * 全部不可用时抛出明确错误（并列出已探测路径），绝不静默降级为空提示词
 * （安全准则不可缺失）。
 *
 * 资源分发：`.md` 不是 TS，tsc / esbuild 都不会自动带上，需要构建期复制：
 *   - `packages/core` 构建时由 `scripts/copy-prompts.mjs` 复制到 `dist/prompts/`；
 *   - 桌面端打包时由 `scripts/bundle.mjs` 复制到 `dist/prompts/`（随 asar 分发）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * esbuild 打包成 CJS 后 `__dirname` 原生可用；ESM（源码直跑 / tsc 产物）下不存在。
 * 本地声明以同时满足两种形态的类型检查（`declare` 不产生运行时代码）。
 */
declare const __dirname: string | undefined;

/**
 * 取本模块所在目录。
 *
 * 注意：**不能用** `fileURLToPath(import.meta.url)` 直接取 —— esbuild 在
 * `format: 'cjs'` 下会把 `import.meta` 替换为空对象（`url === undefined`），
 * `fileURLToPath(undefined)` 会抛 TypeError。旧实现把整个候选路径收集都放在
 * 一个 try/catch 里，于是异常被吞掉、候选列表为空，**打包后的应用必然报
 * 「prompts 目录未找到」**。因此这里优先 `__dirname`，并逐项独立容错。
 */
function moduleDir(): string | undefined {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname;
  const meta = import.meta as unknown as { url?: unknown };
  const url = typeof meta.url === 'string' ? meta.url : undefined;
  if (!url) return undefined;
  try {
    return path.dirname(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

/** 收集候选 prompts 目录（按优先级）。 */
function candidatesOf(explicit?: string): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const here = moduleDir();
  if (here) {
    // 模块同级 prompts/
    candidates.push(path.join(here, 'prompts'));
    // 上一级 prompts/：dist/prompts（core 的 tsc 产物）或
    // dist/prompts（桌面端打包后的 dist/main → dist/prompts）
    candidates.push(path.join(here, '..', 'prompts'));
    // 源码期：dist/prompts/../.. → packages/core/src/prompts
    candidates.push(path.join(here, '..', '..', 'src', 'prompts'));
  }
  // Electron：随应用分发（extraResources 或 asar 外）的副本
  const res = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  if (typeof res === 'string' && res.length > 0) {
    candidates.push(path.join(res, 'prompts'));
    candidates.push(path.join(res, 'app.asar.unpacked', 'prompts'));
  }
  return candidates;
}

/** L2 能力段：工具/能力名 → 文件名（capabilities/<file>.md）。 */
export const CAPABILITY_FILES: Record<string, string> = {
  read_file: 'read',
  glob: 'read',
  grep: 'read',
  write_file: 'write',
  edit_file: 'write',
  shell: 'shell',
  todo_list: 'todo',
  task: 'task',
  memory_write: 'memory',
  memory_search: 'memory',
  memory_forget: 'memory',
  screenshot: 'vision',
};

/** L3 策略段：policy mode → 文件名（policy/<file>.md）。 */
export const POLICY_FILES: Record<string, string> = {
  readonly: 'readonly',
  auto: 'auto',
  'full-auto': 'full-auto',
};

export class PromptAssets {
  private readonly cache = new Map<string, string>();

  constructor(private readonly promptsDir?: string) {}

  /** 定位 prompts 目录（显式 > 模块相关 > Electron resources）。 */
  dir(): string {
    const candidates = candidatesOf(this.promptsDir);
    for (const c of candidates) {
      try {
        if (fs.existsSync(path.join(c, 'identity.md'))) return c;
      } catch {
        /* 该候选不可读，试下一个 */
      }
    }
    throw new Error(
      'prompts 目录未找到（identity.md 缺失）。已探测以下路径：\n' +
        candidates.map((c) => `  - ${c}`).join('\n') +
        '\n请确认 packages/core/src/prompts 已随代码部署；' +
        '构建时运行 `node packages/core/scripts/copy-prompts.mjs` 会复制到 dist/prompts。',
    );
  }

  /** 读取相对 prompts 目录的文件（结果按内容缓存）。 */
  read(rel: string): string {
    const hit = this.cache.get(rel);
    if (hit !== undefined) return hit;
    const abs = path.join(this.dir(), rel);
    const text = fs.readFileSync(abs, 'utf8');
    this.cache.set(rel, text);
    return text;
  }

  /** 文件不存在时返回 undefined（用于可选段，如 identity-lite）。 */
  tryRead(rel: string): string | undefined {
    try {
      return this.read(rel);
    } catch {
      return undefined;
    }
  }

  /** L0 基座全文。 */
  identity(): string {
    return this.read('identity.md').trim();
  }

  /** L0 精简版（超长模型降级用，§15.6）。 */
  identityLite(): string {
    return (this.tryRead('identity-lite.md') ?? this.identity()).trim();
  }

  /** L2 单工具准则段。 */
  capability(file: string): string | undefined {
    return this.tryRead(path.join('capabilities', `${file}.md`))?.trim();
  }

  /** L3 单档策略文案。 */
  policy(mode: string): string | undefined {
    const file = POLICY_FILES[mode];
    if (!file) return undefined;
    return this.tryRead(path.join('policy', `${file}.md`))?.trim();
  }

  /**
   * promptVersion：prompts 目录全部 .md 内容的 hash 前 8 位（§15.5）。
   * 任一文件变更即改变版本号，便于把会话与其所用的 prompt 版本对上。
   */
  version(): string {
    const root = this.dir();
    const files: string[] = [];
    const walk = (d: string, prefix: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rel);
        else if (e.name.endsWith('.md')) files.push(rel);
      }
    };
    walk(root, '');
    const h = createHash('sha256');
    for (const f of files) h.update(f).update('\0').update(fs.readFileSync(path.join(root, f)));
    return h.digest('hex').slice(0, 8);
  }
}
