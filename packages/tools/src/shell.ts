/**
 * shell：在工作区执行命令（L1 超时强杀 + 输出截断）（M3 §3.3.6 / M6 §6.4）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { SandboxResult, ToolResult } from '@mozi/shared';
import type { AgentTool, ToolContext } from './types.js';
import { ok, truncate } from './types.js';
import type { Workspace } from './workspace.js';

/**
 * 把沙箱执行结果归一化为工具返回（合并 stdout/stderr、截断、标记错误与隔离元信息）。
 */
function sandboxToToolResult(raw: SandboxResult): ToolResult {
  let combined = raw.stdout;
  if (raw.stderr) {
    const errLines = raw.stderr
      .split('\n')
      .map((l) => `[stderr] ${l}`)
      .join('\n');
    combined = combined ? `${combined}\n${errLines}` : errLines;
  }
  const { text, truncated } = truncate(combined, 200, 50);
  const isError = (raw.exitCode ?? 1) !== 0;
  return {
    callId: '',
    content: text,
    isError,
    meta: {
      exitCode: raw.exitCode ?? undefined,
      sandboxLevel: raw.level,
      sandboxDegradedFrom: raw.degradedFrom,
      sandboxNote: raw.note,
      truncated,
    },
  };
}

interface ShellInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const MAX_TIMEOUT = 600_000;

export const shellTool: AgentTool<ShellInput> = {
  name: 'shell',
  version: '1.0.0',
  riskLevel: 'exec',
  description: [
    'Run a shell command inside the workspace and capture stdout/stderr.',
    'stderr lines are prefixed with [stderr]. Long outputs are truncated (head 200 + tail 50).',
    'Dangerous commands may be blocked or require approval by the policy engine.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      cwd: {
        type: 'string',
        description: 'Working directory (relative to workspace), default root.',
      },
      timeoutMs: { type: 'number', description: 'Timeout, default 120000, max 600000.' },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Extra env vars.',
      },
    },
    required: ['command'],
  },
  async execute(input: ShellInput, ctx: ToolContext) {
    const ws: Workspace = ctx.workspace;
    const cwd = input.cwd ? ws.resolve(input.cwd) : ws.root;
    const timeoutMs = Math.min(input.timeoutMs ?? 120_000, MAX_TIMEOUT);

    // 若引擎注入了沙箱执行器，则经沙箱通道执行（统一隔离策略 + 降级）。
    if (ctx.sandbox) {
      if (!fs.existsSync(cwd)) {
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch {
          /* best effort */
        }
      }
      const raw = await ctx.sandbox.exec(
        input.command,
        {
          cwd,
          env: input.env,
          timeoutMs,
          networkAllowed: true,
        },
        ctx.signal,
      );
      return sandboxToToolResult(raw);
    }

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellArgs = isWin ? ['/c', input.command] : ['-c', input.command];
    const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;

    if (!fs.existsSync(cwd)) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        /* best effort */
      }
    }

    const child = spawn(shell, shellArgs, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) {
          if (isWin) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        }
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (c) => resolve(c ?? null));
    });
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);

    let combined = stdout;
    if (stderr) {
      const errLines = stderr
        .split('\n')
        .map((l) => `[stderr] ${l}`)
        .join('\n');
      combined = combined ? `${combined}\n${errLines}` : errLines;
    }
    const { text, truncated } = truncate(combined, 200, 50);
    const isError = timedOut ? true : (code ?? 1) !== 0;
    return {
      callId: '',
      content: text,
      isError,
      meta: {
        exitCode: code ?? undefined,
        truncated,
        errorKind: timedOut ? 'timeout' : isError ? 'exit_nonzero' : undefined,
      },
    };
  },
};
