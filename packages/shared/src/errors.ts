/**
 * 统一错误码与错误类型。
 * 所有包共用 MoziError，边界处统一 normalize 为 AgentError 再进入事件流 / UI。
 */

export const ErrorCodes = {
  // 引擎层
  ERR_SESSION_BUSY: 'ERR_SESSION_BUSY',
  ERR_MAX_STEPS: 'ERR_MAX_STEPS',
  ERR_TOKEN_BUDGET: 'ERR_TOKEN_BUDGET',
  ERR_COST_LIMIT: 'ERR_COST_LIMIT',
  // 模型层
  ERR_PROVIDER_UNAVAILABLE: 'ERR_PROVIDER_UNAVAILABLE',
  ERR_PROVIDER_TIMEOUT: 'ERR_PROVIDER_TIMEOUT',
  ERR_MODEL_AUTH: 'ERR_MODEL_AUTH',
  ERR_MODEL_RATE_LIMIT: 'ERR_MODEL_RATE_LIMIT',
  ERR_TOOLCALL_PARSE: 'ERR_TOOLCALL_PARSE',
  // 工具层
  ERR_TOOL_NOT_FOUND: 'ERR_TOOL_NOT_FOUND',
  ERR_TOOL_TIMEOUT: 'ERR_TOOL_TIMEOUT',
  ERR_TOOL_VALIDATION: 'ERR_TOOL_VALIDATION',
  ERR_TOOL_INTERNAL: 'ERR_TOOL_INTERNAL',
  // 文件层
  ERR_PATH_OUTSIDE: 'ERR_PATH_OUTSIDE',
  ERR_FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
  ERR_PATCH_PARSE: 'ERR_PATCH_PARSE',
  ERR_PATCH_MISMATCH: 'ERR_PATCH_MISMATCH',
  // 沙箱
  ERR_SANDBOX_UNSUPPORTED: 'ERR_SANDBOX_UNSUPPORTED',
  ERR_SANDBOX_SPAWN: 'ERR_SANDBOX_SPAWN',
  // MCP（v1.2 预留）
  ERR_MCP_INIT_TIMEOUT: 'ERR_MCP_INIT_TIMEOUT',
  ERR_MCP_UNAVAILABLE: 'ERR_MCP_UNAVAILABLE',
  ERR_MCP_AUTH_REQUIRED: 'ERR_MCP_AUTH_REQUIRED',
  ERR_MCP_PROTOCOL: 'ERR_MCP_PROTOCOL',
  // 持久化
  ERR_PERSIST_WRITE: 'ERR_PERSIST_WRITE',
  ERR_SESSION_CONFLICT: 'ERR_SESSION_CONFLICT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class MoziError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, recoverable = false, detail?: unknown) {
    super(message);
    this.name = 'MoziError';
    this.code = code;
    this.recoverable = recoverable;
    this.detail = detail;
  }
}

/** 把任意 throw 规整为 MoziError（保留已识别的错误码）。 */
export function toMoziError(err: unknown): MoziError {
  if (err instanceof MoziError) return err;
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code && code in ErrorCodes) {
      return new MoziError(code as ErrorCode, err.message, false, err.stack);
    }
    return new MoziError(ErrorCodes.ERR_TOOL_INTERNAL, err.message, true, err.stack);
  }
  return new MoziError(ErrorCodes.ERR_TOOL_INTERNAL, String(err), true);
}
