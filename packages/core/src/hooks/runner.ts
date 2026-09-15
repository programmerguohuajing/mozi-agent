/**
 * M18 Hooks 执行器（§18.4 精确规格）。
 *
 * 进程模型：每次触发 spawn 一次（无守护；快进快出；幂等由脚本自负）
 * 载荷：stdin = JSON（事件载荷 + 会话上下文摘要）；stdout/stderr 各截 4KB
 * 退出码：0 continue（stdout 若为 {"note":"..."} 则注入下轮）/ 2 block / 其他 → onExit 映射（默认 ask）
 * 超时：默认 5s（可配 ≤60s），超时按 onExit['*'] + 告警
 * 环境：HOOK_EVENT / HOOK_SESSION_ID；cwd = workspace；不继承 mozi 进程密钥环境
 * 失败隔离：崩溃/不存在 → onExit['*']（默认 continue）+ 事件记录；连续失败 10 次自动禁用
 * 执行通道：不过沙箱（等同用户直接执行），但全部执行进审计日志
 */
import { type ChildProcess, exec } from 'node:child_process';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_FAILURE_LIMIT,
  HOOK_OUTPUT_LIMIT,
  type HookAction,
  type HookEvent,
  type HookMatch,
  type HookOutcome,
  MAX_HOOK_TIMEOUT_MS,
  type ResolvedHook,
} from './types.js';

export interface HookPayload {
  event: HookEvent;
  /** 事件特定字段（tool/arguments/result/durationMs/call/decision/…）。 */
  [key: string]: unknown;
}

export interface HookRunnerOptions {
  workspace: string;
  /** 命令执行器（测试注入）。 */
  execFn?: (
    command: string,
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin: string },
  ) => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    failed: boolean;
  }>;
  /** 审计回调（§18.4：全部执行进审计日志）。 */
  audit?: (ev: { hook: ResolvedHook; payload: HookPayload; outcome: HookOutcome }) => void;
  /** 告警回调（超时 / 自动禁用）。 */
  onWarning?: (msg: string, detail?: unknown) => void;
}

export class HookRunner {
  /** 每个 hook（按来源+路径+索引）的连续失败计数。 */
  private readonly failures = new Map<string, number>();
  /** 已被自动禁用的 hook id。 */
  private readonly disabled = new Set<string>();

  constructor(private readonly opts: HookRunnerOptions) {}

  /** hook 稳定 id。 */
  private idOf(h: ResolvedHook): string {
    return `${h.origin}:${h.source}#${h.index}:${h.event}`;
  }

  isDisabled(h: ResolvedHook): boolean {
    return this.disabled.has(this.idOf(h));
  }

  /** 是否匹配给定载荷（§18.3 match 语义）。 */
  matches(match: HookMatch | undefined, payload: HookPayload): boolean {
    if (!match) return true;
    if (match.tool && payload.tool !== match.tool) return false;
    if (match.agentType && payload.agentType !== match.agentType) return false;
    if (match.commandPattern) {
      const cmd = typeof payload.command === 'string' ? payload.command : '';
      try {
        if (!new RegExp(match.commandPattern).test(cmd)) return false;
      } catch {
        return false;
      }
    }
    if (match.pathGlob) {
      const file = typeof payload.path === 'string' ? payload.path : '';
      if (!globMatch(match.pathGlob, file)) return false;
    }
    return true;
  }

  /**
   * 对某事件的全部 hook 依次执行。
   * 只有 tool:pre / approval:pre 这类「前置」事件会短路（block 即停），
   * 其余事件全部执行完（收集 note）。
   */
  async run(
    event: HookEvent,
    hooks: ResolvedHook[],
    payload: HookPayload,
    ctx: { sessionId: string; blocking?: boolean },
  ): Promise<HookOutcome[]> {
    const applicable = hooks.filter((h) => h.event === event && !this.isDisabled(h));
    const outcomes: HookOutcome[] = [];
    for (const h of applicable) {
      if (!this.matches(h.match, payload)) continue;
      const outcome = await this.executeOne(h, payload, ctx);
      outcomes.push(outcome);
      this.opts.audit?.({ hook: h, payload, outcome });
      if (ctx.blocking && outcome.action === 'block') break; // 短路
    }
    return outcomes;
  }

  private async executeOne(
    h: ResolvedHook,
    payload: HookPayload,
    ctx: { sessionId: string },
  ): Promise<HookOutcome> {
    const timeoutMs = Math.min(
      Math.max(h.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, 1),
      MAX_HOOK_TIMEOUT_MS,
    );
    const stdin = JSON.stringify({
      ...payload,
      sessionId: ctx.sessionId,
      workspace: this.opts.workspace,
    });
    // 环境：仅暴露事件与会话 id；不继承 mozi 进程密钥（白名单式构造）
    const env: NodeJS.ProcessEnv = {
      HOOK_EVENT: h.event,
      HOOK_SESSION_ID: ctx.sessionId,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
        : {}),
    };

    const started = Date.now();
    let res: {
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      failed: boolean;
    };
    try {
      res = await this.exec(h.run, { cwd: this.opts.workspace, env, timeoutMs, stdin });
    } catch (e) {
      res = {
        code: null,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        failed: true,
      };
    }
    const durationMs = Date.now() - started;

    const stdout = clip(res.stdout);
    const stderr = clip(res.stderr);
    const action = this.decide(res.code, res.timedOut, res.failed, h.onExit);

    if (res.timedOut) {
      this.opts.onWarning?.(`hook 超时（${timeoutMs}ms）：${h.run}`, { event: h.event });
    }

    // 失败隔离：崩溃/不存在/超时计入连续失败；成功则清零
    const id = this.idOf(h);
    if (res.failed || res.timedOut) {
      const n = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, n);
      if (n >= HOOK_FAILURE_LIMIT) {
        this.disabled.add(id);
        this.opts.onWarning?.(`hook 连续失败 ${n} 次，已自动禁用：${h.run}`, {
          event: h.event,
          source: h.source,
          index: h.index,
        });
      }
    } else {
      this.failures.set(id, 0);
    }

    const outcome: HookOutcome = {
      hook: h,
      action,
      exitCode: res.code,
      stdout,
      stderr,
      durationMs,
      timedOut: res.timedOut,
      failed: res.failed,
      ...(res.code === 0 ? { note: extractNote(stdout) } : {}),
    };
    if (!outcome.note) outcome.note = undefined;
    return outcome;
  }

  /** 退出码 → 动作（§18.4）。 */
  private decide(
    code: number | null,
    timedOut: boolean,
    failed: boolean,
    onExit?: Record<string, HookAction>,
  ): HookAction {
    const fallback = onExit?.['*'] ?? 'continue';
    if (timedOut || failed || code === null) return fallback;
    if (code === 0) return 'continue';
    if (code === 2) return 'block';
    return onExit?.[String(code)] ?? onExit?.['*'] ?? 'ask';
  }

  private exec(
    command: string,
    o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin: string },
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    failed: boolean;
  }> {
    if (this.opts.execFn) return this.opts.execFn(command, o);
    return new Promise((resolve) => {
      let timedOut = false;
      let child: ChildProcess;
      try {
        child = exec(
          command,
          {
            cwd: o.cwd,
            env: o.env,
            timeout: o.timeoutMs,
            windowsHide: true,
            maxBuffer: HOOK_OUTPUT_LIMIT * 4,
          },
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : err
                  ? null
                  : 0;
            resolve({
              code,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              timedOut,
              failed: Boolean(err) && code === null,
            });
          },
        );
      } catch (e) {
        // 命令不存在：exec 同步抛错
        resolve({
          code: null,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
          timedOut: false,
          failed: true,
        });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
      }, o.timeoutMs + 50);
      child.on('exit', () => clearTimeout(timer));
      child.on('error', () => clearTimeout(timer));
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* 脚本可能不读 stdin → EPIPE，忽略 */
        });
        child.stdin.end(o.stdin);
      }
    });
  }

  /** 重置失败计数（测试用）。 */
  resetFailures(): void {
    this.failures.clear();
    this.disabled.clear();
  }
}

/** stdout 截断（各 4KB，§18.4）。 */
function clip(s: string): string {
  if (Buffer.byteLength(s, 'utf8') <= HOOK_OUTPUT_LIMIT) return s;
  return `${Buffer.from(s, 'utf8').subarray(0, HOOK_OUTPUT_LIMIT).toString('utf8')}\n...[truncated]`;
}

/** 解析 stdout 的 {"note":"..."}（§18.4：注入下轮系统提示）。 */
export function extractNote(stdout: string): string | undefined {
  const t = stdout.trim();
  if (!t) return undefined;
  const candidate = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  if (!candidate) return undefined;
  try {
    const obj = JSON.parse(candidate) as { note?: unknown };
    return typeof obj.note === 'string' && obj.note.trim() ? obj.note : undefined;
  } catch {
    return undefined;
  }
}

/** 极简 glob 匹配：支持 `**`、`*`、`?`（§18.6 pathGlob 用例）。 */
export function globMatch(pattern: string, file: string): boolean {
  const norm = file.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` 或 `**`
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(norm);
  } catch {
    return false;
  }
}
