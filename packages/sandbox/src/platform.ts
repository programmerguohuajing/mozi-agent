/**
 * 平台探测（M6 §6.4）：判断当前 OS 与可用沙箱能力，供选择链决策。
 */
import { spawnSync } from 'node:child_process';

export type Platform = 'win32' | 'darwin' | 'linux' | 'other';

export interface SandboxSupport {
  platform: Platform;
  /** 是否安装了 docker（L3 容器隔离需要）。 */
  hasDocker: boolean;
  /** 是否支持 L2 OS 沙箱（纯 JS 可实现的范围内：macOS sandbox-exec）。 */
  l2Supported: boolean;
  /** L2 不支持时的说明（用于降级告警）。 */
  l2Note?: string;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 探测某个命令是否可用（PATH 中可解析且能启动）。 */
export function hasCommand(name: string): boolean {
  const shell = isWindows() ? 'where' : 'command';
  const arg = isWindows() ? name : '-v';
  try {
    const r = spawnSync(shell, [arg, name], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 探测沙箱支持矩阵。
 * - macOS：sandbox-exec（Seatbelt）可用 → L2 完整支持。
 * - Linux：Landlock/seccomp 需要原生 helper，纯 JS 无法实现 → L2 降级为 L1。
 * - Windows：无 Seatbelt 等价物（Job Object 需 Win32 API）→ L2 降级为 L1。
 */
export function detectSandboxSupport(): SandboxSupport {
  const platform: Platform =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : 'other';

  const hasDocker = hasCommand('docker');

  let l2Supported = false;
  let l2Note: string | undefined;
  if (platform === 'darwin') {
    l2Supported = hasCommand('sandbox-exec');
    if (!l2Supported) l2Note = 'macOS 未找到 sandbox-exec，L2 降级为 L1';
  } else if (platform === 'linux') {
    l2Note = 'Linux 的 Landlock/seccomp 需原生 helper，纯 JS 不支持，L2 降级为 L1；如需强隔离请使用 L3 容器';
  } else if (platform === 'win32') {
    l2Note = 'Windows 无 Seatbelt 等价物（Job Object 需 Win32 API），L2 降级为 L1；建议使用 L3 Docker 获得强隔离';
  } else {
    l2Note = '未知平台，L2 降级为 L1';
  }

  return { platform, hasDocker, l2Supported, l2Note };
}
