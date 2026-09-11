/**
 * 内置 Git 工具：结构化 Git 操作（不经过 shell，直接调用 git 二进制）。
 *
 * 与 shell 工具的区别：返回结构化 JSON 而非原始文本，便于 agent 解析；
 * 直接 spawn('git', [...args]) 避免 shell 注入风险；操作粒度更细。
 *
 * riskLevel: 'exec'（含 push/pull 等网络写操作）。
 */
import { spawn } from 'node:child_process';
import type { AgentTool, ToolContext } from './types.js';
import { ok, fail, truncate } from './types.js';

// ── 类型 ────────────────────────────────────────────────────────────

type GitAction =
  | 'status' | 'diff' | 'log' | 'show' | 'branch'
  | 'add' | 'commit' | 'restore' | 'stash'
  | 'push' | 'pull' | 'fetch'
  | 'checkout' | 'merge' | 'rebase'
  | 'remote' | 'init';

interface GitInput {
  action: GitAction;
  /** 目标文件路径（add/restore/diff），相对于 workspace。 */
  files?: string[];
  /** commit 消息（commit），分支名（checkout/branch create），remote 名（push/pull/fetch）。 */
  message?: string;
  /** 分支名（checkout/branch create/delete）。 */
  branch?: string;
  /** remote 名称（push/pull/fetch），默认 origin。 */
  remote?: string;
  /** diff 选项：'staged' | 'unstaged' | 指定 commit hash。 */
  ref?: string;
  /** log 条目数，默认 20。 */
  limit?: number;
  /** stash 操作：'push' | 'pop' | 'list' | 'drop'。 */
  stashAction?: 'push' | 'pop' | 'list' | 'drop';
  /** stash 索引（drop），默认 0。 */
  stashIndex?: number;
  /** 强制操作（push --force / branch -D）。 */
  force?: boolean;
  /** 超时毫秒，默认 30000。 */
  timeoutMs?: number;
}

// ── git 命令执行 ────────────────────────────────────────────────────

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 0 }); });
  });
}

// ── 结构化解析 ──────────────────────────────────────────────────────

interface GitStatusEntry {
  index: string;      // 暂存区状态字母
  working: string;    // 工作区状态字母
  path: string;
  staged: boolean;
}

function parseStatus(porcelain: string): GitStatusEntry[] {
  return porcelain.split('\n').filter((line) => line && !line.startsWith('##')).map((line) => {
    const index = line[0] ?? ' ';
    const working = line[1] ?? ' ';
    const path = line.slice(3);
    return { index, working, path, staged: index !== ' ' && index !== '?' };
  });
}

interface GitLogEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  refs: string;
}

function parseLog(log: string): GitLogEntry[] {
  // 格式：%H%x09%an%x09%ae%x09%aI%x09%s%x09%D（tab 分隔）
  return log.split('\n').filter(Boolean).map((line) => {
    const [hash, author, email, date, message, refs] = line.split('\t');
    return { hash: hash ?? '', author: author ?? '', email: email ?? '', date: date ?? '', message: message ?? '', refs: refs ?? '' };
  });
}

interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  hash: string;
}

function parseBranches(output: string): BranchInfo[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const current = line.startsWith('*');
    const trimmed = current ? line.slice(2) : line;
    const [hash, ...rest] = trimmed.split(' ');
    const name = rest.join(' ');
    return { name, current, remote: name.includes('/'), hash: hash ?? '' };
  });
}

// ── 工具实现 ────────────────────────────────────────────────────────

export const gitTool: AgentTool<GitInput> = {
  name: 'git',
  version: '1.0.0',
  riskLevel: 'exec',
  description: [
    'Built-in Git tool providing structured Git operations.',
    'Actions: status (structured file states), diff (staged/unstaged/by ref), log (commit history),',
    'branch (list/create/delete), add, commit, restore, stash (push/pop/list/drop),',
    'push, pull, fetch, checkout, merge, rebase, remote, init, show.',
    'Returns structured JSON for easy parsing. Uses git binary directly (not shell).',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'restore',
               'stash', 'push', 'pull', 'fetch', 'checkout', 'merge', 'rebase', 'remote', 'init'],
        description: 'Git action to perform.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target file paths (relative to workspace), for add/restore/diff.',
      },
      message: {
        type: 'string',
        description: 'Commit message (commit), branch name (checkout/branch), or remote name (push/pull/fetch).',
      },
      branch: {
        type: 'string',
        description: 'Branch name for checkout/branch operations.',
      },
      remote: {
        type: 'string',
        description: 'Remote name (default: origin), for push/pull/fetch.',
      },
      ref: {
        type: 'string',
        description: "Diff option: 'staged', 'unstaged', or a commit hash. For show: commit hash.",
      },
      limit: {
        type: 'number',
        description: 'Number of log entries (default: 20).',
      },
      stashAction: {
        type: 'string',
        enum: ['push', 'pop', 'list', 'drop'],
        description: 'Stash sub-action (when action=stash).',
      },
      stashIndex: {
        type: 'number',
        description: 'Stash index for drop (default: 0).',
      },
      force: {
        type: 'boolean',
        description: 'Force operation (push --force, branch -D).',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000).',
      },
    },
    required: ['action'],
  },
  async execute(input: GitInput, ctx: ToolContext) {
    const cwd = ctx.workspace.root;
    const timeoutMs = input.timeoutMs ?? 30_000;

    // 验证 cwd 是 git 仓库（init 除外）
    if (input.action !== 'init') {
      const check = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, 5000);
      if (check.exitCode !== 0) {
        return fail(`Not a git repository: ${cwd} (run git init first)`, 'not_a_repo');
      }
    }

    switch (input.action) {
      // ── 只读操作 ──────────────────────────────────────────────
      case 'status': {
        const r = await runGit(['status', '--porcelain=v1', '-b'], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git status failed', 'git_error');
        const entries = parseStatus(r.stdout);
        const staged = entries.filter((e) => e.staged);
        const modified = entries.filter((e) => !e.staged && e.working !== ' ');
        const untracked = entries.filter((e) => e.index === '?' && e.working === '?');
        // 提取分支信息行
        const branchLine = r.stdout.split('\n')[0] ?? '';
        return ok(JSON.stringify({ branch: branchLine, staged, modified, untracked, total: entries.length }, null, 2));
      }

      case 'diff': {
        const args = ['diff'];
        if (input.ref === 'staged') args.push('--cached');
        else if (input.ref === 'unstaged') { /* default */ }
        else if (input.ref) args.push(input.ref);
        if (input.files?.length) args.push('--', ...input.files);
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git diff failed', 'git_error');
        const { text, truncated } = truncate(r.stdout || '(no changes)', 200, 50);
        return ok(text, { kind: 'diff', truncated } as never);
      }

      case 'log': {
        const limit = input.limit ?? 20;
        const fmt = '%H%x09%an%x09%ae%x09%aI%x09%s%x09%D';
        const r = await runGit(['log', `--format=${fmt}`, `-n${limit}`], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git log failed', 'git_error');
        const entries = parseLog(r.stdout);
        return ok(JSON.stringify(entries, null, 2));
      }

      case 'show': {
        if (!input.ref) return fail('show requires a commit hash (ref parameter)', 'missing_ref');
        const r = await runGit(['show', input.ref], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git show failed', 'git_error');
        const { text, truncated } = truncate(r.stdout, 200, 50);
        return ok(text, { kind: 'diff', truncated } as never);
      }

      case 'branch': {
        if (input.branch) {
          // 创建或删除分支
          const args = input.force ? ['branch', '-D', input.branch] : ['branch', input.branch];
          const r = await runGit(args, cwd, timeoutMs);
          if (r.exitCode !== 0) return fail(r.stderr || `git branch ${input.branch} failed`, 'git_error');
          return ok(`Branch ${input.force ? 'deleted' : 'created'}: ${input.branch}`);
        }
        // 列出分支
        const r = await runGit(['branch', '--list', '--format=%(objectname:short) %(refname:short)'], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git branch failed', 'git_error');
        // current branch 需要单独获取
        const cur = await runGit(['branch', '--show-current'], cwd, 5000);
        const branches = r.stdout.split('\n').filter(Boolean).map((line) => {
          const [hash, name] = line.split(' ');
          return { name: name ?? '', current: name === cur.stdout.trim(), remote: (name ?? '').includes('/'), hash: hash ?? '' };
        });
        return ok(JSON.stringify(branches, null, 2));
      }

      case 'remote': {
        const r = await runGit(['remote', '-v'], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git remote failed', 'git_error');
        const remotes = r.stdout.split('\n').filter(Boolean).map((line) => {
          const [name, url] = line.split('\t');
          return { name: name ?? '', url: (url ?? '').replace(/\s\((fetch|push)\)/, '') };
        });
        return ok(JSON.stringify(remotes, null, 2));
      }

      // ── 写操作 ────────────────────────────────────────────────
      case 'add': {
        const files = input.files?.length ? input.files : ['.'];
        const r = await runGit(['add', '--', ...files], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git add failed', 'git_error');
        return ok(`Staged ${files.length} file(s): ${files.join(', ')}`);
      }

      case 'commit': {
        if (!input.message) return fail('commit requires a message', 'missing_message');
        const r = await runGit(['commit', '-m', input.message], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git commit failed', 'git_error');
        return ok(`Committed: ${input.message}\n${r.stdout.trim()}`);
      }

      case 'restore': {
        const files = input.files?.length ? input.files : ['.'];
        const args = ['restore'];
        if (input.ref === 'staged') args.push('--staged');
        args.push('--', ...files);
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git restore failed', 'git_error');
        return ok(`Restored ${files.length} file(s)`);
      }

      case 'stash': {
        const sub = input.stashAction ?? 'push';
        const args = ['stash'];
        if (sub === 'list') { args.push('list'); }
        else if (sub === 'pop') { args.push('pop'); }
        else if (sub === 'drop') { args.push('drop', `stash@{${input.stashIndex ?? 0}}`); }
        // push: no extra args needed
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || `git stash ${sub} failed`, 'git_error');
        if (sub === 'list') {
          const entries = r.stdout.split('\n').filter(Boolean);
          return ok(JSON.stringify(entries, null, 2));
        }
        return ok(`Stash ${sub}: ${r.stdout.trim() || r.stderr.trim()}`);
      }

      case 'checkout': {
        if (!input.branch) return fail('checkout requires a branch name', 'missing_branch');
        const args = input.force ? ['checkout', '-f', input.branch] : ['checkout', input.branch];
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || `git checkout ${input.branch} failed`, 'git_error');
        return ok(`Switched to branch: ${input.branch}`);
      }

      case 'push': {
        const remote = input.remote ?? 'origin';
        const branch = input.branch ?? '';
        const args = ['push', ...(input.force ? ['--force'] : []), remote];
        if (branch) args.push(branch);
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git push failed', 'git_error');
        return ok(`Pushed to ${remote}${branch ? '/' + branch : ''}\n${r.stdout.trim()}`);
      }

      case 'pull': {
        const remote = input.remote ?? 'origin';
        const branch = input.branch ?? '';
        const args = ['pull', remote];
        if (branch) args.push(branch);
        const r = await runGit(args, cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git pull failed', 'git_error');
        return ok(`Pulled from ${remote}${branch ? '/' + branch : ''}\n${r.stdout.trim()}`);
      }

      case 'fetch': {
        const remote = input.remote ?? 'origin';
        const r = await runGit(['fetch', remote], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git fetch failed', 'git_error');
        return ok(`Fetched from ${remote}\n${r.stdout.trim()}`);
      }

      case 'merge': {
        if (!input.branch) return fail('merge requires a branch name', 'missing_branch');
        const r = await runGit(['merge', input.branch], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || `git merge ${input.branch} failed`, 'git_error');
        return ok(`Merged: ${input.branch}\n${r.stdout.trim()}`);
      }

      case 'rebase': {
        if (!input.branch) return fail('rebase requires a branch name', 'missing_branch');
        const r = await runGit(['rebase', input.branch], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || `git rebase ${input.branch} failed`, 'git_error');
        return ok(`Rebased onto: ${input.branch}\n${r.stdout.trim()}`);
      }

      case 'init': {
        const r = await runGit(['init'], cwd, timeoutMs);
        if (r.exitCode !== 0) return fail(r.stderr || 'git init failed', 'git_error');
        return ok(`Initialized git repository: ${cwd}\n${r.stdout.trim()}`);
      }

      default:
        return fail(`Unknown git action: ${input.action}`, 'unknown_action');
    }
  },
};