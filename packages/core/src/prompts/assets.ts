/**
 * Prompt 资源加载（M15 §15.4）：`prompts/` 目录为提示词的版本化唯一真源
 * （git 管理，promptVersion = 目录内容 hash 前 8 位）。
 *
 * 由于本仓库无资源拷贝构建步骤，加载器按候选路径依次探测：
 *   1. 显式注入的 promptsDir
 *   2. 与本模块同级的 prompts/（dist/prompts 或 src/prompts，取决于运行形态）
 * 二者皆不可用时抛出明确错误，绝不静默降级为空提示词（安全准则不可缺失）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  /** 定位 prompts 目录（显式 > 模块同级）。 */
  dir(): string {
    const candidates: string[] = [];
    if (this.promptsDir) candidates.push(this.promptsDir);
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.join(here, 'prompts'));
      candidates.push(path.join(here, '..', 'prompts'));
      candidates.push(path.join(here, '..', '..', 'src', 'prompts'));
    } catch {
      /* ignore */
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(path.join(c, 'identity.md'))) return c;
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      'prompts 目录未找到（identity.md 缺失）。请确认 packages/core/src/prompts 已随代码部署。',
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
