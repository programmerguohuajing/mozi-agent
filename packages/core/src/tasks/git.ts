/**
 * 产物隔离所需的 git 辅助（M4.5 / M13 §13.6）：worktree 管理 / commit / diff / 非 git 降级。
 * 全部经子进程 git CLI（跨平台）；非 git 目录降级为目录快照 + patch 文件。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function git(cwd: string | undefined, ...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, 'rev-parse', '--is-inside-work-tree').ok;
}

/** 在 repo 内创建 worktree（独立分支 mozi/task/<taskId>/<ts>）；失败返回 null */
export function worktreeAdd(
  repoDir: string,
  worktreeDir: string,
  branch: string,
): { ok: boolean; error?: string } {
  mkdirSync(dirname(worktreeDir), { recursive: true });
  const r = git(repoDir, 'worktree', 'add', worktreeDir, '-b', branch);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || r.stdout };
}

/** worktree 内提交产物（有改动才提交）；返回是否产生 commit 与 changed 文件清单 */
export function commitWorktree(
  worktreeDir: string,
  message: string,
): { committed: boolean; changedFiles: string[] } {
  const status = git(worktreeDir, 'status', '--porcelain');
  if (!status.ok || !status.stdout) return { committed: false, changedFiles: [] };
  const changed = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  git(worktreeDir, 'add', '-A');
  const commit = git(worktreeDir, 'commit', '-m', message);
  return { committed: commit.ok, changedFiles: changed };
}

export function worktreeRemove(repoDir: string, worktreeDir: string): void {
  git(repoDir, 'worktree', 'remove', '--force', worktreeDir);
  rmSync(worktreeDir, { recursive: true, force: true });
}

/** 快照复制目录（非 git 工作区的 branch/pr 降级用） */
export function snapshotCopy(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, force: true });
}

/** 递归列出目录内文件（跳过 .git） */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

/** 对比两份目录，生成统一 diff patch 文件；返回改动文件清单（非 git 降级产物） */
export function diffDirectories(beforeDir: string, afterDir: string, patchFile: string): string[] {
  const files = new Set([...listFiles(beforeDir), ...listFiles(afterDir)]);
  const chunks: string[] = [];
  const changed: string[] = [];
  for (const rel of [...files].sort()) {
    const before = join(beforeDir, rel);
    const after = join(afterDir, rel);
    const aExists = existsSync(before);
    const bExists = existsSync(after);
    if (!bExists) {
      chunks.push(`diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ /dev/null`);
      changed.push(rel);
      continue;
    }
    if (!aExists) {
      chunks.push(`diff --git a/${rel} b/${rel}\nnew file: ${rel}`);
      changed.push(rel);
      continue;
    }
    const a = readFileSync(before, 'utf8');
    const b = readFileSync(after, 'utf8');
    if (a !== b) {
      chunks.push(`diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}`);
      changed.push(rel);
    }
  }
  if (changed.length) {
    mkdirSync(dirname(patchFile), { recursive: true });
    writeFileSync(patchFile, `${chunks.join('\n')}\n`, 'utf8');
  }
  return changed;
}

/** 获取仓库当前分支名（product 信息用） */
export function currentBranch(repoDir: string): string | undefined {
  const r = git(repoDir, 'branch', '--show-current');
  return r.ok && r.stdout ? r.stdout : undefined;
}