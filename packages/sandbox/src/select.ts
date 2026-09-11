/**
 * 沙箱选择链（M6 §6.4）：根据请求级别 + 平台支持矩阵，选出最终生效的隔离档位，
 * 并在无法满足时优雅降级（记录 degradedFrom / note，绝不静默失败）。
 */
import type {
  SandboxLevel,
  SandboxOptions,
  SandboxResult,
  SandboxRunner,
} from '@mozi/shared';
import { detectSandboxSupport, type SandboxSupport } from './platform.js';
import { mergeAllowNet } from './network.js';
import { execL0, execL1, execL2, execL3, KILLED_EXIT_CODE } from './exec.js';

/** 创建沙箱执行器时的可选配置。 */
export interface SandboxConfig {
  /** 请求的隔离级别（0/1/2/3）。 */
  level: SandboxLevel;
  /** L3 容器镜像（默认 alpine:3）。 */
  dockerImage?: string;
  /** 追加到默认网络白名单的域名（替代默认白名单）。 */
  allowNet?: string[];
}

const DEFAULT_DOCKER_IMAGE = 'alpine:3';

/**
 * 把一次命令执行归一化为统一的 SandboxResult（补全 level / degradedFrom）。
 */
function toResult(
  raw: { stdout: string; stderr: string; exitCode: number | null; durationMs: number },
  effectiveLevel: SandboxLevel,
  requestedLevel: SandboxLevel,
  note?: string,
): SandboxResult {
  return {
    ...raw,
    level: effectiveLevel,
    degradedFrom: effectiveLevel !== requestedLevel ? requestedLevel : undefined,
    note: effectiveLevel !== requestedLevel ? note : note,
  };
}

/**
 * 创建沙箱执行器。
 * 降级规则：
 * - 请求 L2 但平台不支持 OS 沙箱（非 macOS Seatbelt 可用）→ 降级 L1，附说明。
 * - 请求 L3 但无 docker → 递归尝试 L2（再按 L2 规则降级）。
 */
export function createSandbox(cfg: SandboxConfig): SandboxRunner {
  const support = detectSandboxSupport();
  const image = cfg.dockerImage ?? DEFAULT_DOCKER_IMAGE;
  const allowNet = cfg.allowNet && cfg.allowNet.length ? mergeAllowNet(cfg.allowNet) : mergeAllowNet();

  const requested = cfg.level;

  // 计算实际生效级别（含降级）。
  const resolution = resolveLevel(requested, support);
  const effective = resolution.level;

  const exec = async (
    cmd: string,
    opts: SandboxOptions,
    signal?: AbortSignal,
  ): Promise<SandboxResult> => {
    const env = opts.env;
    const timeout = opts.timeoutMs;
    const netAllowed = opts.networkAllowed;
    const allow = opts.allowNet && opts.allowNet.length ? mergeAllowNet(opts.allowNet) : allowNet;

    let raw: { stdout: string; stderr: string; exitCode: number | null; durationMs: number };
    switch (effective) {
      case 0:
        raw = await execL0(cmd, opts.cwd, env, timeout, signal);
        break;
      case 1:
        raw = await execL1(cmd, opts.cwd, env, timeout, signal);
        break;
      case 2:
        // 到达此处说明平台支持 L2（macOS Seatbelt）。
        raw = await execL2(cmd, opts.cwd, env, timeout, netAllowed, allow, signal);
        break;
      case 3:
        raw = await execL3(cmd, opts.cwd, env, timeout, image, netAllowed, signal);
        break;
      default:
        raw = await execL1(cmd, opts.cwd, env, timeout, signal);
    }
    return toResult(raw, effective, requested, resolution.note);
  };

  return { level: effective, exec };
}

interface LevelResolution {
  level: SandboxLevel;
  note?: string;
}

/** 根据请求级别与平台支持，解析最终生效级别。 */
function resolveLevel(requested: SandboxLevel, support: SandboxSupport): LevelResolution {
  switch (requested) {
    case 0:
    case 1:
      return { level: requested };
    case 2: {
      if (support.l2Supported) return { level: 2 };
      return { level: 1, note: support.l2Note ?? '当前平台不支持 OS 沙箱，L2 降级为 L1' };
    }
    case 3: {
      if (support.hasDocker) return { level: 3 };
      // 无 docker：尝试 L2。
      if (support.l2Supported) return { level: 2, note: '未检测到 docker，L3 降级为 L2' };
      return { level: 1, note: '未检测到 docker，且当前平台不支持 OS 沙箱，L3 降级为 L1' };
    }
    default:
      return { level: 1 };
  }
}

/** 测试/调试辅助：仅解析级别，不创建执行器。 */
export function previewLevel(requested: SandboxLevel, support?: SandboxSupport): LevelResolution {
  return resolveLevel(requested, support ?? detectSandboxSupport());
}

export { KILLED_EXIT_CODE };
