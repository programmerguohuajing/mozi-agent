/**
 * 快照管理（M2 /undo）：edit_file/write_file 事务快照的落盘与恢复。
 * 设计（M3 §3.5.4）：每次修改前将原文件复制到 <sessionDir>/snapshots/<ts>-<safeName>；
 * /undo 弹出最近一组快照恢复。恢复属破坏性动作，UI 层需先确认。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SnapshotEntry {
  ts: number;
  /** 快照内文件相对 workspace 的路径 */
  files: string[];
}

/** 将一组「路径 → 原内容」快照落盘（null 内容 = 文件此前不存在）。 */
export function saveSnapshot(
  snapshotDir: string,
  entries: Record<string, string | null>,
): SnapshotEntry {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const ts = Date.now();
  const manifest = { ts, files: Object.keys(entries) };
  fs.writeFileSync(
    path.join(snapshotDir, `${ts}.manifest.json`),
    JSON.stringify(manifest),
    'utf-8',
  );
  for (const [p, content] of Object.entries(entries)) {
    const safe = p.replace(/[\\/]/g, '__');
    if (content == null) {
      // 文件此前不存在：记录删除标记
      fs.writeFileSync(path.join(snapshotDir, `${ts}-${safe}.ABSENT`), '', 'utf-8');
    } else {
      fs.writeFileSync(path.join(snapshotDir, `${ts}-${safe}`), content, 'utf-8');
    }
  }
  return manifest;
}

/** 列出快照（旧 → 新）。 */
export function listSnapshots(snapshotDir: string): SnapshotEntry[] {
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(snapshotDir, f), 'utf-8')) as SnapshotEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is SnapshotEntry => e != null)
    .sort((a, b) => a.ts - b.ts);
}

/** 恢复最近一组快照到 workspace。返回恢复的文件路径列表；无快照返回 null。 */
export function undoLast(
  snapshotDir: string,
  restore: (path: string, content: string) => void,
  remove: (path: string) => void,
): string[] | null {
  const snaps = listSnapshots(snapshotDir);
  const last = snaps[snaps.length - 1];
  if (!last) return null;

  for (const p of last.files) {
    const safe = p.replace(/[\\/]/g, '__');
    const absent = path.join(snapshotDir, `${last.ts}-${safe}.ABSENT`);
    const data = path.join(snapshotDir, `${last.ts}-${safe}`);
    if (fs.existsSync(absent)) {
      remove(p);
    } else if (fs.existsSync(data)) {
      restore(p, fs.readFileSync(data, 'utf-8'));
    }
  }

  // 消费掉该快照（防止重复 undo）
  fs.rmSync(path.join(snapshotDir, `${last.ts}.manifest.json`), { force: true });
  for (const p of last.files) {
    const safe = p.replace(/[\\/]/g, '__');
    fs.rmSync(path.join(snapshotDir, `${last.ts}-${safe}`), { force: true });
    fs.rmSync(path.join(snapshotDir, `${last.ts}-${safe}.ABSENT`), { force: true });
  }
  return last.files;
}
