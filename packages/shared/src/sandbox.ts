/**
 * 沙箱契约（M6 §6.4）：统一抽象，由 @mozi/sandbox 实现，工具经此通道执行命令。
 * 放在 shared 层是因为它是「工具 → 执行」之间的跨层契约（保持 foundation 只依赖 shared 的铁律）。
 */

/** 沙箱隔离级别：0 无隔离 / 1 进程资源限制 / 2 OS 沙箱 / 3 容器。 */
export type SandboxLevel = 0 | 1 | 2 | 3;

/** 单次命令执行的可选项。 */
export interface SandboxOptions {
  /** 工作目录（绝对路径）。 */
  cwd: string;
  /** 追加到进程环境（密钥经配置层解析后注入）。 */
  env?: Record<string, string>;
  /** 超时强杀（毫秒），0 表示不强制（仍受引擎 toolTimeoutMs 兜底）。 */
  timeoutMs: number;
  /** 是否允许网络出站（L2/L3 经白名单代理生效）。 */
  networkAllowed: boolean;
  /** 网络白名单域名（networkAllowed 时生效，如 ['registry.npmjs.org']）。 */
  allowNet?: string[];
}

/** 单次命令执行结果。 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  /** 退出码；被杀/异常时为 null。 */
  exitCode: number | null;
  durationMs: number;
  /** 实际生效的沙箱级别（可能因平台降级而低于请求级别）。 */
  level: SandboxLevel;
  /** 若因平台限制发生降级，记录原始请求级别。 */
  degradedFrom?: SandboxLevel;
  /** 降级/告警说明（非致命）。 */
  note?: string;
}

/** 沙箱执行器：引擎与工具只认这个接口。 */
export interface SandboxRunner {
  readonly level: SandboxLevel;
  /** signal 用于取消执行（与引擎 AbortSignal 对齐）。 */
  exec(cmd: string, opts: SandboxOptions, signal?: AbortSignal): Promise<SandboxResult>;
}
