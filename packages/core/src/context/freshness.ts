/**
 * 文件新鲜度跟踪（详细设计 §5.6）。
 * 引擎在工具读取文件后记录指纹（mtime/size），每轮 buildContext 时做增量比对；
 * 模型读过、之后又被修改（write_file/edit_file/shell 副作用）的文件 → 脏列表注入上下文头部，
 * 提醒模型重新 read_file。从未被模型读过的文件不提示（无意义）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

/** 读写过的路径 → 指纹快照（相对路径）。 */
export class FreshnessTracker {
  private readonly seen = new Map<string, FileFingerprint>();

  /** 工具读取文件后调用：记录当前指纹（基准）。 */
  markRead(absPath: string): void {
    try {
      const st = fs.statSync(absPath);
      this.seen.set(absPath, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* 文件不存在则不记录 */
    }
  }

  /** 每轮 buildContext 时调用：返回「自基准后已被修改的文件」绝对路径列表，并刷新基准。 */
  checkDirty(): string[] {
    const dirty: string[] = [];
    for (const [abs, fp] of this.seen) {
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs !== fp.mtimeMs || st.size !== fp.size) {
          dirty.push(abs);
          this.seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size }); // 刷新基准
        }
      } catch {
        // 文件被删除也算脏
        dirty.push(abs);
        this.seen.delete(abs);
      }
    }
    return dirty;
  }

  /** 相对化展示（workspace 内才转换）。 */
  static relativize(abs: string, workspaceRoot: string): string {
    const rel = path.relative(workspaceRoot, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    return abs;
  }
}
