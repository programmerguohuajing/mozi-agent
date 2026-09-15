/**
 * 工作区路径边界（M6 §6.5）：解析 + 规范化 + 越界校验 + symlink 二次校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, MoziError } from '@mozi/shared';

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** 解析 + 边界校验；symlink 存在则 realpath 二次确认仍在边界内。返回绝对路径。 */
  resolve(p: string): string {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p);
    const normalized = path.normalize(abs);
    if (!this.inside(normalized)) {
      throw new MoziError(
        ErrorCodes.ERR_PATH_OUTSIDE,
        `path '${p}' resolves outside workspace root '${this.root}'`,
      );
    }
    if (fs.existsSync(normalized)) {
      const real = fs.realpathSync(normalized);
      if (!this.inside(real)) {
        throw new MoziError(
          ErrorCodes.ERR_PATH_OUTSIDE,
          `path '${p}' escapes workspace via symlink`,
        );
      }
      return real;
    }
    return normalized;
  }

  private inside(p: string): boolean {
    const rel = path.relative(this.root, p);
    if (rel === '') return true;
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
  }

  /** 读取文件内容（路径相对 workspa*/
  readFile(p: string): string | null {
    try {
      const abs = this.resolve(p);
      return fs.readFileSync(abs, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 写入文件（自动创建父目录，路径相对 workspace）。 */
  writeFile(p: string, content: string): void {
    const abs = this.resolve(p);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, abs);
  }

  /** 删除文件（路径相对 workspace）。 */
  deleteFile(p: string): void {
    const abs = this.resolve(p);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: false });
    }
  }
}
