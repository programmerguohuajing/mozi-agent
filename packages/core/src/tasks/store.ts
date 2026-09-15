/**
 * 任务清单存储（M4.5 / M13 §13.3）：~/.mozi/tasks/tasks.json，原子写 + .bak 备份。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskSpec } from './types.js';

const SCHEMA_VERSION = 1;

interface TaskListFile {
  schemaVersion: number;
  tasks: TaskSpec[];
}

export function newTaskId(rand = Math.random): string {
  const r8 = Math.floor(rand() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `task-${r8}`;
}

export class TaskStore {
  constructor(private readonly file: string) {}

  load(): TaskSpec[] {
    if (!fileExists(this.file)) return [];
    try {
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw) as TaskListFile;
      if (data.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `tasks.json schemaVersion 不兼容：${data.schemaVersion} != ${SCHEMA_VERSION}`,
        );
      }
      return data.tasks ?? [];
    } catch (e) {
      // 主文件损坏 → 尝试 .bak 恢复（M7 迁移机制同款）
      const bak = `${this.file}.bak`;
      if (fileExists(bak)) {
        const raw = readFileSync(bak, 'utf8');
        const data = JSON.parse(raw) as TaskListFile;
        this.save(data.tasks ?? []);
        return data.tasks ?? [];
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 原子写：tmp + rename，写前备份 .bak */
  save(tasks: TaskSpec[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const data: TaskListFile = { schemaVersion: SCHEMA_VERSION, tasks };
    const tmp = join(dirname(this.file), `.tasks-${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (fileExists(this.file)) {
      try {
        renameSync(this.file, `${this.file}.bak`);
      } catch {
        /* 备份失败不阻塞写入 */
      }
    }
    renameSync(tmp, this.file);
  }

  get(id: string): TaskSpec | undefined {
    return this.load().find((t) => t.id === id);
  }

  add(spec: TaskSpec): void {
    const tasks = this.load();
    if (tasks.some((t) => t.id === spec.id)) throw new Error(`任务已存在：${spec.id}`);
    tasks.push(spec);
    this.save(tasks);
  }

  update(id: string, patch: Partial<TaskSpec>): TaskSpec | undefined {
    const tasks = this.load();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return undefined;
    tasks[idx] = { ...tasks[idx]!, ...patch, id };
    this.save(tasks);
    return tasks[idx];
  }

  remove(id: string): boolean {
    const tasks = this.load();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    this.save(next);
    return true;
  }

  setEnabled(id: string, enabled: boolean): TaskSpec | undefined {
    const tasks = this.load();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return undefined;
    tasks[idx] = { ...tasks[idx]!, enabled };
    this.save(tasks);
    return tasks[idx];
  }
}

function fileExists(p: string): boolean {
  return existsSync(p);
}
