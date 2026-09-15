/**
 * 远程协议（M4.75 / M14 §14.2-14.5）：与传输无关的设备信任/配对/权限/游标/幂等/附件。
 * 移动端协议 = 桌面 IPC 协议（§14 原则 3）：此处补充远程管理组（设备/附件/任务）。
 */
import { createHash, randomBytes } from 'node:crypto';

// ---------- 设备权限模型（§14.5）─────────────────────────────────────

export interface DevicePermissions {
  viewSessions: boolean; // 查看会话与实时细节（默认开）
  viewWorkspaceFiles: boolean; // 只读浏览工作区文件（默认 false）
  sendMessage: boolean; // 向会话/新会话下发任务（默认 true）
  approveRequests: 'none' | 'standard' | 'all'; // 审批权（默认 standard）
  triggerTasks: boolean; // 手动触发定时任务（默认 true）
  manageDevices: boolean; // 管理其他设备（默认 false）
  changePolicy: boolean; // 切换审批模式/沙箱（默认 false）
}

export const DEFAULT_DEVICE_PERMISSIONS: DevicePermissions = {
  viewSessions: true,
  viewWorkspaceFiles: false,
  sendMessage: true,
  approveRequests: 'standard',
  triggerTasks: true,
  manageDevices: false,
  changePolicy: false,
};

/** 审批风险等级（与 M6 RiskAnalyzer 输出的 overall 对齐）。 */
export type ApprovalRisk = 'safe' | 'side-effect' | 'network' | 'high';

export type ApprovalAction = 'approve' | 'defer' | 'reject';

/**
 * 移动端审批分级（§14.5）：
 *  - none：一律 reject
 *  - standard：safe/side-effect/network 可 approve；high 只 defer（暂缓/转交桌面）
 *  - all：全 approve（节点侧仍需生物识别 + 冷静期，由调用方约束）
 */
export function approvalPermitted(
  permissions: DevicePermissions,
  risk: ApprovalRisk,
): ApprovalAction {
  if (permissions.approveRequests === 'none') return 'reject';
  if (permissions.approveRequests === 'all') return 'approve';
  return risk === 'high' ? 'defer' : 'approve';
}

// ---------- 设备注册表（§14.4：只存 tokenHash，可吊销）────────────────

export interface DeviceRecord {
  deviceId: string;
  name: string;
  platform: string;
  pubKey: string; // base64 Curve25519 公钥
  tokenHash: string; // SHA-256(deviceToken)
  permissions: DevicePermissions;
  pairedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomDeviceToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomDeviceId(): string {
  return `dev_${randomBytes(6).toString('hex')}`;
}

export interface DeviceRegistryIO {
  load(): DeviceRecord[];
  save(records: DeviceRecord[]): void;
}

/** 设备注册表：原子读写（节点侧 ~/.mozi/devices.json），吊销即 token 失效。 */
export class DeviceRegistry {
  private records: DeviceRecord[];
  private readonly io: DeviceRegistryIO;

  constructor(io: DeviceRegistryIO) {
    this.io = io;
    this.records = io.load();
  }

  list(): DeviceRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.records.find((r) => r.deviceId === deviceId);
  }

  register(record: DeviceRecord): void {
    this.records.push({ ...record });
    this.io.save(this.records);
  }

  verifyToken(deviceId: string, tokenHash: string): boolean {
    const r = this.get(deviceId);
    return !!r && !r.revokedAt && r.tokenHash === tokenHash;
  }

  touch(deviceId: string): void {
    const r = this.get(deviceId);
    if (!r) return;
    r.lastSeenAt = new Date().toISOString();
    this.io.save(this.records);
  }

  revoke(deviceId: string): boolean {
    const r = this.get(deviceId);
    if (!r) return false;
    r.revokedAt = new Date().toISOString();
    this.io.save(this.records);
    return true;
  }

  rename(deviceId: string, name: string): boolean {
    const r = this.get(deviceId);
    if (!r) return false;
    r.name = name;
    this.io.save(this.records);
    return true;
  }
}

// ---------- 配对（§14.4：6 位码 / TTL 5min / 单次使用 / 暴力锁定）────

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 10;
export const PAIRING_LOCK_MS = 5 * 60_000;

export type PairingError = 'expired' | 'locked' | 'not-found' | 'already-used';

interface PairingInfo {
  code: string;
  nodeId: string;
  createdAt: number;
  used: boolean;
}

export class PairingService {
  private readonly pairings = new Map<string, PairingInfo>();
  private attempts = 0;
  private lockedUntil = 0;

  constructor(
    private readonly nodeId: string,
    private readonly opts: { now?: () => number; rand?: (n: number) => Buffer } = {},
  ) {}

  /** 节点侧生成配对会话（QR/终端码）。 */
  createPairing(): { code: string; ttlMs: number } {
    const rand = this.opts.rand ?? ((n: number) => randomBytes(n));
    const code = String(rand(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    this.pairings.set(code, { code, nodeId: this.nodeId, createdAt: this.now(), used: false });
    this.prune();
    return { code, ttlMs: PAIRING_TTL_MS };
  }

  /** 设备提交配对码；成功即单次消费。 */
  verify(code: string): { ok: true; nodeId: string } | { ok: false; error: PairingError } {
    if (this.now() < this.lockedUntil) return { ok: false, error: 'locked' };
    this.prune();
    const p = this.pairings.get(code);
    if (!p) return { ok: false, error: 'not-found' };
    if (this.now() - p.createdAt > PAIRING_TTL_MS) return { ok: false, error: 'expired' };
    if (p.used) return { ok: false, error: 'already-used' };
    p.used = true; // 单次使用
    this.attempts = 0;
    return { ok: true, nodeId: p.nodeId };
  }

  /** 校验失败计数（暴力锁定：MAX 次窗口内锁定 5min）。 */
  recordFailure(): void {
    this.attempts += 1;
    if (this.attempts >= PAIRING_MAX_ATTEMPTS) this.lockedUntil = this.now() + PAIRING_LOCK_MS;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [code, p] of this.pairings) {
      if (now - p.createdAt > PAIRING_TTL_MS) this.pairings.delete(code);
    }
  }
}

// ---------- 事件游标 / 断线续传（§14.3 / §14.6）──────────────────────

export interface EventRecord {
  seq: number;
  sessionId: string;
  event: unknown;
}

/** 会话事件历史（上限裁剪），供 lastEventId 断线重放。 */
export class EventLog {
  private readonly bySession = new Map<string, EventRecord[]>();
  private seq = 0;

  constructor(private readonly maxPerSession = 2000) {}

  append(sessionId: string, event: unknown): EventRecord {
    const rec: EventRecord = { seq: ++this.seq, sessionId, event };
    let list = this.bySession.get(sessionId);
    if (!list) {
      list = [];
      this.bySession.set(sessionId, list);
    }
    list.push(rec);
    if (list.length > this.maxPerSession) list.splice(0, list.length - this.maxPerSession);
    return rec;
  }

  /** 从 lastEventId（不含）之后该会话的全部事件。 */
  replaySince(sessionId: string, lastEventId?: number): EventRecord[] {
    const list = this.bySession.get(sessionId) ?? [];
    if (lastEventId === undefined) return [...list];
    return list.filter((r) => r.seq > lastEventId);
  }

  lastSeq(): number {
    return this.seq;
  }
}

// ---------- requestId 幂等（§14.3：弱网重试安全）──────────────────────

export const IDEMPOTENT_CHANNELS = ['run:start', 'approval:resolve'] as const;

export function isIdempotentChannel(channel: string): boolean {
  return (IDEMPOTENT_CHANNELS as readonly string[]).includes(channel);
}

export class RequestDeduper {
  private readonly seen = new Map<string, unknown>();

  constructor(private readonly max = 1000) {}

  /** 幂等去重：同 requestId 命中缓存返回原结果。 */
  check<T>(requestId: string, compute: () => T): { deduped: boolean; result: T } {
    if (this.seen.has(requestId)) {
      return { deduped: true, result: this.seen.get(requestId) as T };
    }
    const result = compute();
    this.seen.set(requestId, result);
    if (this.seen.size > this.max) {
      const first = this.seen.keys().next().value as string;
      this.seen.delete(first);
    }
    return { deduped: false, result };
  }
}

// ---------- 附件外置（§14.6②：大对象降级为 contentId 引用）───────────

export const ATTACHMENT_INLINE_LIMIT = 8_192; // >8KB 转附件引用

export interface AttachmentRef {
  contentId: string;
  kind: string;
  totalChunks: number;
  chunkSize: number;
}

export interface AttachmentExternalResult {
  /** true 表示 payload 被替换为附件引用。 */
  externalized: boolean;
  payload: unknown;
  ref?: AttachmentRef;
}

/** 把大 display 载荷（text/content/diff 字段 > limit）替换为附件引用。 */
export function externalizeAttachment(
  payload: unknown,
  allocator: (data: string, kind: string) => AttachmentRef,
  limit = ATTACHMENT_INLINE_LIMIT,
): AttachmentExternalResult {
  if (payload === null || typeof payload !== 'object') return { externalized: false, payload };
  const obj = payload as Record<string, unknown>;
  for (const key of ['text', 'content', 'diff']) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > limit) {
      const ref = allocator(value, key);
      return { externalized: true, payload: { ...obj, [key]: undefined, _attachment: ref }, ref };
    }
  }
  return { externalized: false, payload };
}
