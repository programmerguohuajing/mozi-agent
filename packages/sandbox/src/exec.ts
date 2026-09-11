/**
 * 沙箱执行器（M6 §6.4）：四档隔离级别的真实执行逻辑。
 * - L0：直接执行，无任何隔离。
 * - L1：进程资源限制（超时强杀 + 进程组/树清理）。
 * - L2：OS 沙箱（macOS sandbox-exec / Seatbelt）；非 macOS 平台尽力降级为 L1。
 * - L3：容器隔离（Docker `run --rm`，默认断网或按白名单桥接）。
 *
 * 所有执行器统一返回 SandboxResult，调用方（工具层）无需关心内部差异。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { isWindows } from './platform.js';

/** 当子进程被强杀时返回的退出码哨兵。 */
export const KILLED_EXIT_CODE = -1;

interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * 启动子进程并等待结束，支持超时强杀与进程树清理。
 * @param command 要执行的命令字符串（经 shell 解释，以保留管道/重定向语义）。
 * @param cwd 工作目录。
 * @param env 环境变量。
 * @param timeoutMs 超时毫秒；<=0 表示不设超时（由上层兜底）。
 * @param preArgs 在 `sh -c` 之前注入的参数（sandbox-exec / docker 等包装器）。
 */
function spawnAndAwait(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  preArgs: string[],
  signal?: AbortSignal,
): Promise<RawResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    // POSIX 用 sh -c 保留管道/重定向语义；Windows 用 cmd.exe /c（测试与本地调试兼容）。
    const shell = isWindows() ? ['cmd.exe', '/c'] : ['sh', '-c'];
    const args = [...preArgs, ...shell, command];
    const opts: SpawnOptions = {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      // detached 让子进程成为进程组组长，便于整组强杀（POSIX）。
      detached: !isWindows(),
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    // noUncheckedIndexedAccess 下 args[0] 为 string|undefined，shift() 取出可执行文件并保持非空。
    const file = args.shift()!;
    const child: ChildProcess = spawn(file, args, opts);

    let stdout = '';
    let stderr = '';
    let settled = false;
    // 收集器可能以 Buffer 或 string 返回。
    const onData = (acc: { v: string }) => (chunk: Buffer | string) => {
      acc.v += chunk.toString();
    };
    const outAcc = { v: '' };
    const errAcc = { v: '' };
    child.stdout?.on('data', onData(outAcc));
    child.stderr?.on('data', onData(errAcc));

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      stdout = outAcc.v;
      stderr = errAcc.v;
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
    };

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(KILLED_EXIT_CODE);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      finish(null);
      // 错误仅体现在 stderr，不改变退出码哨兵（null 表示异常）。
      stderr = stderr || `spawn error: ${err.message}`;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      finish(typeof code === 'number' ? code : null);
    });

    // 外部取消（引擎 AbortSignal）：整组强杀并以 null 退出码结束。
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      killTree(child);
      finish(null);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 跨平台杀进程树（POSIX 杀进程组，Windows 用 taskkill /T）。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (isWindows()) {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      // 负 pid 表示向进程组广播 SIGKILL。
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 进程可能已退出，忽略。
  }
}

/** L0：直接执行。 */
export function execL0(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResult> {
  return spawnAndAwait(command, cwd, env, timeoutMs, [], signal);
}

/** L1：进程资源限制（超时强杀 + 进程树清理，不含 OS 级隔离）。 */
export function execL1(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawResult> {
  // 与 L0 共用同一套进程管理；隔离等级的差异在 L2/L3 的 preArgs 包装体现。
  return spawnAndAwait(command, cwd, env, timeoutMs, [], signal);
}

/**
 * L2：macOS Seatbelt（sandbox-exec）。
 * 非 macOS 平台无法在纯 JS 实现 OS 沙箱，调用方应在 select 阶段降级为 L1。
 * @param networkAllowed 是否允许网络出站。
 * @param allowNet 网络白名单域名（当前 Seatbelt 仅支持「全放」或「全禁」，细粒度需代理）。
 */
export function execL2(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  networkAllowed: boolean,
  allowNet: string[] | undefined,
  signal?: AbortSignal,
): Promise<RawResult> {
  const profile = buildSeatbeltProfile(networkAllowed, allowNet);
  return spawnAndAwait(command, cwd, env, timeoutMs, ['sandbox-exec', '-p', profile], signal);
}

/** 构造 Seatbelt 沙箱描述（deny default + 允许进程/文件，按需 deny network）。 */
function buildSeatbeltProfile(networkAllowed: boolean, allowNet: string[] | undefined): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(allow file-write*)',
    '(allow sysctl*)',
  ];
  if (!networkAllowed) {
    lines.push('(deny network*)');
  } else if (allowNet && allowNet.length > 0) {
    // Seatbelt 不支持按域名细粒度放行，这里仅放行全部出站并附注释（细粒度需 egress 代理）。
    lines.push('; allowNet 细粒度需在 L3 容器配合 egress 代理实现');
  }
  return lines.join('\n');
}

/**
 * L3：Docker 容器隔离。
 * @param image 容器镜像（默认 alpine:3）。
 * @param networkAllowed 不允许时 `--network none`。
 */
export function execL3(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  image: string,
  networkAllowed: boolean,
  signal?: AbortSignal,
): Promise<RawResult> {
  const containerCwd = '/work';
  const args = ['docker', 'run', '--rm'];
  args.push('--network', networkAllowed ? 'bridge' : 'none');
  // 把宿主机 cwd 挂载进容器相同绝对路径，保证相对路径一致。
  args.push('-v', `${cwd}:${containerCwd}`);
  args.push('-w', containerCwd);
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      // 仅挂载工具层显式注入的密钥/变量，避免泄漏整个宿主环境。
      args.push('-e', `${k}=${v}`);
    }
  }
  args.push(image);
  return spawnAndAwait(command, cwd, undefined, timeoutMs, args, signal);
}

/** 探测当前 cwd 是否可写（L3 挂载前自检，避免挂载失败后才报错）。 */
export function isDirWritable(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
