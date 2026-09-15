/**
 * 三层文件锁（M4.5 / M13 §13.7）：tick 互斥 / 任务 overlap / direct 工作区与交互会话互斥。
 * 实现：原子 mkdir 锁 + holder.json（pid / acquiredAt），崩溃残留按「进程不存在或超龄」抢占。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockHolder {
  pid: number;
  /** epoch 毫秒 */
  acquiredAt: number;
  purpose?: string;
}

export interface LockInfo {
  held: boolean;
  holder?: LockHolder;
  stale: boolean;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class TaskLocks {
  constructor(
    private readonly dir: string,
    private readonly staleMs = 10 * 60_000, // 持有者 10 分钟未更新视为僵尸
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private lockPath(name: string): string {
    // 名称做基本净化，防止路径穿越
    return join(this.dir, `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.lock`);
  }

  info(name: string): LockInfo {
    const p = this.lockPath(name);
    if (!existsSync(p)) return { held: false, stale: false };
    const holder = this.readHolder(p);
    const alive = holder ? isPidAlive(holder.pid) : false;
    const fresh = holder ? Date.now() - holder.acquiredAt < this.staleMs : false;
    const stale = !alive || !fresh;
    return { held: !stale, holder, stale };
  }

  /**
   * 获取锁（非阻塞）。返回 false 表示被他人持有（stale 时可抢占）。
   */
  acquire(name: string, purpose?: string, maxWaitMs = 5_000): Promise<boolean> {
    return this.acquireWithRetry(name, purpose, maxWaitMs);
  }

  private async acquireWithRetry(
    name: string,
    purpose: string | undefined,
    maxWaitMs: number,
  ): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      const p = this.lockPath(name);
      try {
        mkdirSync(p); // 原子：已存在则抛 EEXIST
        writeFileSync(
          join(p, 'holder.json'),
          JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            purpose,
          } satisfies LockHolder),
          'utf8',
        );
        return true;
      } catch {
        const info = this.info(name);
        if (info.stale) {
          // 抢占：先删僵尸锁目录
          this.release(name);
          continue;
        }
        if (Date.now() - started >= maxWaitMs) return false;
        await sleep(100);
      }
    }
  }

  release(name: string): void {
    const p = this.lockPath(name);
    try {
      rmSync(join(p, 'holder.json'), { force: true });
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* 已不存在 */
    }
  }

  private readHolder(p: string): LockHolder | undefined {
    try {
      const raw = readFileSync(join(p, 'holder.json'), 'utf8');
      const h = JSON.parse(raw) as LockHolder;
      if (typeof h.pid === 'number' && typeof h.acquiredAt === 'number') return h;
      return undefined;
    } catch {
      return undefined;
    }
  }
}
