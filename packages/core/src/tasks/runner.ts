/**
 * 任务执行编排（M4.5 / M13 §13.6）：前置检查 → workspace 隔离（worktree/快照）→ headless run
 * → 产物收集（branch/pr/direct/report-only）→ 报告与运行记录落盘。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderRegistry } from '@mozi/providers';
import type { TaskSpec } from './types.js';
import type { RunRecord } from './types.js';
import { runHeadless, type HeadlessOutcome } from './headless.js';
import {
  commitWorktree,
  diffDirectories,
  isGitRepo,
  snapshotCopy,
  worktreeAdd,
  worktreeRemove,
} from './git.js';

export interface RunOnceOptions {
  providers: ProviderRegistry;
  runsDir: string;
  worktreesDir: string;
  trigger: 'schedule' | 'manual';
  missedRuns?: number;
  onEvent?: (ev: unknown) => void;
}

export interface RunOnceResult {
  record: RunRecord;
  reportFile: string;
}

/** 执行一次任务（不含 state 更新/通知——由调度器统一负责） */
export async function executeTaskOnce(spec: TaskSpec, opts: RunOnceOptions): Promise<RunOnceResult> {
  const startedAt = new Date().toISOString();
  const ts = Date.now();
  const runId = `run-${ts}`;
  const runDir = join(opts.runsDir, spec.id, runId);
  const sessionDir = join(runDir, 'session');
  const reportFile = join(runDir, 'report.md');
  mkdirSync(runDir, { recursive: true });

  // ── 0/1. workspace 准备：按产物策略决定执行目录 ──
  const artifact = spec.config.artifact;
  const repoDir = spec.workspace;
  let execDir = repoDir;
  let worktreeDir: string | undefined;
  let snapshotDir: string | undefined;
  const branch = `mozi/task/${spec.id}/${runId}`;
  const worktreeDirPath = join(opts.worktreesDir, `${spec.id}-${runId}`);

  if (!existsSync(repoDir)) {
    return {
      record: makeFailedRecord(spec, runId, startedAt, opts, {
        code: 'ERR_WORKSPACE_MISSING',
        message: `工作区不存在：${repoDir}`,
      }),
      reportFile,
    };
  }

  if (artifact === 'branch' || artifact === 'pr') {
    if (isGitRepo(repoDir)) {
      const add = worktreeAdd(repoDir, worktreeDirPath, branch);
      if (!add.ok) {
        return {
          record: makeFailedRecord(spec, runId, startedAt, opts, {
            code: 'ERR_WORKTREE_ADD',
            message: add.error ?? 'git worktree add 失败',
          }),
          reportFile,
        };
      }
      worktreeDir = worktreeDirPath;
      execDir = worktreeDir;
    } else {
      // 非 git 降级：快照副本
      snapshotDir = join(opts.worktreesDir, `${spec.id}-${runId}-snap`);
      mkdirSync(snapshotDir, { recursive: true });
      snapshotCopy(repoDir, snapshotDir);
      execDir = snapshotDir;
    }
  }

  // ── 2/3. headless 执行 ──
  const outcome: HeadlessOutcome = await runHeadless({
    spec,
    runId,
    workspaceDir: execDir,
    providers: opts.providers,
    sessionDir,
    onEvent: opts.onEvent,
  });

  // ── 3'. 产物收集 ──
  const artifacts: NonNullable<RunRecord['artifacts']> = {};
  if (worktreeDir) {
    const commit = commitWorktree(worktreeDir, `mozi task ${spec.name} ${startedAt}`);
    if (commit.committed) {
      artifacts.branch = branch;
      artifacts.changedFiles = commit.changedFiles;
    }
    worktreeRemove(repoDir, worktreeDir);
  } else if (snapshotDir) {
    const patchFile = join(runDir, 'changes.patch');
    artifacts.changedFiles = diffDirectories(repoDir, snapshotDir, patchFile);
    if (artifacts.changedFiles.length) artifacts.patchFile = patchFile;
  }

  // ── 4. 报告生成 ──
  writeFileSync(reportFile, buildReportMd(spec, runId, startedAt, outcome, artifacts), 'utf8');
  artifacts.reportFile = reportFile;

  const status: RunRecord['status'] =
    outcome.exitCode === 0 ? 'success' : outcome.finishReason === 'timeout' ? 'timeout' : 'failed';
  const record: RunRecord = {
    runId,
    taskId: spec.id,
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    trigger: opts.trigger,
    missedRuns: opts.missedRuns,
    error: outcome.error,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage
      ? {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          totalTokens: outcome.usage.totalTokens,
          costUsd: outcome.usage.costUsd,
        }
      : undefined,
    artifacts,
    summary: outcome.summary,
  };

  // 运行记录落盘（§13.8：run-<ts>.json 与 run-<ts>/ 会话目录并列于 runs/<taskId>/）
  writeFileSync(join(opts.runsDir, spec.id, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { record, reportFile };
}

function makeFailedRecord(
  spec: TaskSpec,
  runId: string,
  startedAt: string,
  opts: RunOnceOptions,
  error: { code: string; message: string },
): RunRecord {
  return {
    runId,
    taskId: spec.id,
    status: 'failed',
    startedAt,
    endedAt: new Date().toISOString(),
    trigger: opts.trigger,
    missedRuns: opts.missedRuns,
    error,
    summary: '',
  };
}

function buildReportMd(
  spec: TaskSpec,
  runId: string,
  startedAt: string,
  outcome: HeadlessOutcome,
  artifacts: NonNullable<RunRecord['artifacts']>,
): string {
  const lines: string[] = [];
  lines.push(`# 定时任务运行报告`);
  lines.push('');
  lines.push(`- 任务：${spec.name}（${spec.id}）`);
  lines.push(`- 运行：${runId} @ ${startedAt} → ${new Date().toISOString()}`);
  lines.push(`- 状态：${outcome.exitCode === 0 ? '✅ 成功' : outcome.finishReason === 'timeout' ? '⏱ 超时' : '❌ 失败'}${outcome.finishReason ? `（${outcome.finishReason}）` : ''}`);
  if (outcome.usage) {
    lines.push(`- 用量：in ${outcome.usage.inputTokens} / out ${outcome.usage.outputTokens} tokens${outcome.usage.costUsd !== undefined ? `（$ ${outcome.usage.costUsd.toFixed(4)}）` : ''}`);
  }
  if (artifacts.branch) lines.push(`- 产物分支：${artifacts.branch}`);
  if (artifacts.patchFile) lines.push(`- 产物 patch：${artifacts.patchFile}`);
  lines.push('');
  lines.push('## 任务指令');
  lines.push('');
  lines.push('```');
  lines.push(spec.prompt);
  lines.push('```');
  lines.push('');
  lines.push('## 模型结论');
  lines.push('');
  lines.push(outcome.summary || '（无结论输出）');
  lines.push('');
  if (outcome.error) {
    lines.push('## 错误');
    lines.push('');
    lines.push(`- ${outcome.error.code}: ${outcome.error.message}`);
    lines.push('');
  }
  lines.push('## 工具调用摘要');
  lines.push('');
  if (outcome.toolSummary.length) {
    lines.push('```');
    lines.push(outcome.toolSummary.join('\n'));
    lines.push('```');
  } else {
    lines.push('（无工具调用）');
  }
  lines.push('');
  if (artifacts.changedFiles?.length) {
    lines.push('## 改动清单');
    lines.push('');
    for (const f of artifacts.changedFiles) lines.push(`- ${f}`);
    lines.push('');
  }
  return lines.join('\n');
}