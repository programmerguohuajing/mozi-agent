/**
 * 任务结果通知（M4.5 / M13 §13.8）：通用 webhook POST（接钉钉/飞书/Slack bot）+ 桌面桩。
 * 载荷统一 schema；10s 超时 + 失败重试 1 次；maskSecret 防 token/密钥泄漏进第三方。
 */
import type { RunRecord } from './types.js';

export interface NotifyPayload {
  event: 'task.completed' | 'task.failed';
  taskId: string;
  taskName: string;
  status: RunRecord['status'];
  startedAt: string;
  endedAt: string;
  costUsd?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  summary?: string;
  branch?: string;
  prUrl?: string;
  reportUrl?: string;
}

const SECRET_KEYS = /(api[_-]?key|token|secret|password|authorization|private[_-]?key)/i;

/** 深度脱敏：值含疑似密钥字段名或 URL 查询参数中的密钥 → *** */
export function maskSecret(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecret(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '***';
    } else if (typeof v === 'string' && SECRET_KEYS.test(v)) {
      out[k] = '***'; // 值本身像密钥（如 'Bearer xxx'）
    } else {
      out[k] = maskSecret(v, depth + 1);
    }
  }
  return out;
}

export interface NotifyResult {
  ok: boolean;
  channel: string;
  error?: string;
}

/** 发送 webhook 通知：POST JSON，10s 超时，失败重试 1 次（通知失败不影响任务状态） */
export async function sendWebhook(
  url: string,
  payload: NotifyPayload,
  opts: { timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {},
): Promise<NotifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 1;
  const body = JSON.stringify(maskSecret(payload));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`webhook 超时 ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, channel: 'webhook' };
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, channel: 'webhook', error: String((lastError as Error)?.message ?? lastError) };
}

/** 构建 webhook 载荷（含可选的报告摘要，默认 1k 字符截断） */
export function buildWebhookPayload(
  record: RunRecord,
  taskName: string,
  opts: { includeReport?: boolean; reportUrl?: string } = {},
): NotifyPayload {
  const includeReport = opts.includeReport ?? true;
  const payload: NotifyPayload = {
    event: record.status === 'success' ? 'task.completed' : 'task.failed',
    taskId: record.taskId,
    taskName,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    costUsd: record.usage?.costUsd,
    usage: record.usage,
    summary: includeReport ? (record.summary ?? '').slice(0, 1_000) : undefined,
    branch: record.artifacts?.branch,
    prUrl: record.artifacts?.prUrl,
    reportUrl: opts.reportUrl ?? record.artifacts?.reportFile,
  };
  return payload;
}