import type { RemotePush, SessionSummary } from '@mozi/protocol';
/**
 * 移动端客户端模型（M4.75 / M14 §14.8）：页面视图模型 + RemoteClient 抽象。
 * 无 Expo/RN 依赖环境下以类型规范落地（tsc --noEmit 可过）；真实 UI 在 pnpm i 后接入。
 */
import type { AgentEvent } from '@mozi/shared';

/** 客户端连接状态（§14.2：心跳 / 重连 / 吊销）。 */
export type ClientConnState = 'disconnected' | 'connecting' | 'connected' | 'revoked';

/** 远程客户端抽象（WSS / 测试 transport 同构）。 */
export interface RemoteClient {
  state(): ClientConnState;
  /** 配对 → 认证 → 订阅。 */
  connect(opts: {
    pairingCode: string;
    deviceName: string;
    platform: string;
    pubKey: string;
  }): Promise<void>;
  auth(deviceId: string, token: string): Promise<void>;
  invoke<T = unknown>(channel: string, params: unknown, requestId?: string): Promise<T>;
  onPush(cb: (frame: RemotePush) => void): () => void;
  attach(sessionId: string, lastEventId?: number): Promise<void>;
  close(): void;
}

// ── 页面视图模型（§14.8 ①-⑥）────────────────────────────────────────

export interface PairPageView {
  nodeFingerprint?: string; // 节点公钥指纹（QR 校验）
  pairingCode?: string;
  stage: 'scan' | 'confirm' | 'naming' | 'done';
}

export interface SessionListItem {
  summary: SessionSummary;
  unreadApprovals: number;
  lastEventId?: number; // 断线续传游标
}

export interface ApprovalInboxItem {
  callId: string;
  sessionId: string;
  callName: string;
  summary: string;
  risk: 'safe' | 'side-effect' | 'network' | 'high';
  /** high 级仅 [暂缓][转交桌面]（§14.5）。 */
  permittedActions: 'approve' | 'defer';
}

export interface TaskPageItem {
  taskId: string;
  name: string;
  enabled: boolean;
  nextRunAt?: string;
  lastStatus?: string;
}

export interface DevicePageItem {
  deviceId: string;
  name: string;
  platform: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** 会话事件 → 移动端渲染项（占位映射，UI 实现时落地）。 */
export function renderMobileEvent(event: AgentEvent): { event: AgentEvent; ts: number } {
  return { event, ts: Date.now() };
}
