/**
 * IpcBridge：把 §10.3 的 channel 清单落到 AgentService 上（M10 §10.2 / §10.3）。
 *
 * 传输无关 —— 通过 `ChannelServer` 注入。Electron 主进程传 `webContents` 适配器，
 * 测试 / TUI 传 `LoopbackChannel`。两种传输共用同一 handler 注册表，
 * 保证「移动端协议 = 桌面 IPC 协议」零分叉（§14 原则 3）。
 *
 * 安全约束（§10.6）：密钥只在主进程；`config:listProviders` 只回脱敏摘要。
 */
import type { AgentEvent } from '@mozi/shared';
import type {
  AuditQueryRequest,
  ChannelServer,
  ConfigGetResponse,
  McpAddRequest,
  McpServerInfo,
  PartialApplyRequest,
  ProviderSummary,
  ProviderTestRequest,
  ProviderTestResponse,
  RunStartRequest,
  SendChannelMap,
  SessionState,
} from '@mozi/protocol';
import { approvalTicketFromEvent } from '@mozi/protocol';
import type { AgentService } from './agent-service.js';
import type { SettingsStore } from './settings-store.js';
import type { DiffReviewService } from './diff-service.js';
import type { McpManager } from './mcp-manager.js';
import type { BrowserService } from './browser-service.js';

export interface IpcBridgeDeps {
  service: AgentService;
  settings: SettingsStore;
  diff: DiffReviewService;
  mcp: McpManager;
  /** 内置浏览器服务（截图标注）。 */
  browser?: BrowserService;
  /**
   * 屏幕截图能力（renderer 输入栏"截图"按钮）：
   * 截取整屏并返回 PNG base64 + 真实像素尺寸。由主进程用 electron.desktopCapturer 注入。
   */
  captureScreen?: ScreenCapturer;
  /** 传输：注册 handler + 推送 send。 */
  channel: ChannelServer;
  /** 当前接收方标识（窗口 id / 连接 id），用于多窗口聚焦判定。 */
  recipientId?: string;
}

/** 屏幕截图结果：`base64` 为不带 data: 前缀的 PNG；`width/height` 为真实像素尺寸（标注坐标依赖）。 */
export interface ScreenCaptureResult {
  base64: string;
  width: number;
  height: number;
}

/** 屏幕截图器（主进程注入；不可用时抛错，由 handler 转为 `{ error }`）。 */
export type ScreenCapturer = () => Promise<ScreenCaptureResult>;

export class IpcBridge {
  private readonly sessionWindow = new Map<string, string>();

  constructor(private readonly deps: IpcBridgeDeps) {}

  /** 注册全部 invoke handler。 */
  install(): void {
    const { channel, service, settings, diff, mcp, browser, captureScreen } = this.deps;

    channel.handle('session:create', async (req) => {
      const summary = await service.create(req);
      this.emitStatus(summary.id, summary.state);
      return summary;
    });

    channel.handle('session:resume', async (req) => {
      const summary = await service.resume(req.sessionId);
      if (summary) this.emitStatus(req.sessionId, summary.state);
      return summary;
    });

    channel.handle('session:fork', async (req) => {
      const summary = await service.fork(req.sessionId, req.atEventIndex);
      // 分叉后自动载入池。
      await service.resume(summary.id);
      return summary;
    });

    channel.handle('session:list', () => service.list());

    channel.handle('session:delete', (req) => service.delete(req.sessionId));

    channel.handle('run:start', (req: RunStartRequest) => {
      const res = service.start(req);
      if (res.accepted) {
        // 回放该会话已积累的待审批（UI 重连补齐）。
        for (const ticket of service.pendingApprovals(req.sessionId)) {
          this.send('engine:event', {
            sessionId: ticket.sessionId,
            event: {
              type: 'tool.approval.required',
              call: ticket.call,
              reason: ticket.reason,
              ts: new Date().toISOString(),
            },
          });
        }
      }
      return res;
    });

    channel.handle('approval:resolve', (req) => {
      const ok = service.resolveApproval(req).ok;
      if (ok && req.onceForSession) settings.appendAllowRule(req.sessionId, req.callId);
      return { ok };
    });

    channel.handle('engine:abort', (req) => service.abort(req));

    channel.handle('config:get', (): ConfigGetResponse => {
      const all = settings.getAll();
      return {
        settings: all,
        providers: settings.listProviders(),
        policyMode: settings.policyMode(),
      };
    });

    channel.handle('config:set', (req) => {
      settings.applyPatch(req.patch);
      return { ok: true };
    });

    channel.handle('config:listProviders', (): ProviderSummary[] => settings.listProviders());

    channel.handle('config:testProvider', async (req: ProviderTestRequest): Promise<ProviderTestResponse> => {
      return settings.testProvider(req.providerId);
    });

    channel.handle('mcp:list', (): McpServerInfo[] => mcp.list());

    channel.handle('mcp:add', async (req: McpAddRequest) => {
      return mcp.add(req);
    });

    channel.handle('mcp:remove', async (req) => mcp.remove(req.id));

    channel.handle('mcp:restart', async (req) => mcp.restart(req.id));

    channel.handle('audit:query', (req: AuditQueryRequest) => service.audit(req));

    channel.handle('dashboard:stats', () => service.dashboard());

    channel.handle('diff:applyPartial', (req: PartialApplyRequest) => diff.applyPartial(req));

    // ── 输入栏"截图"：截取整屏 → 标注 → 作为附件 ──────────────
    channel.handle('browser:capture', async () => {
      // 首选：主进程桌面屏幕捕获（desktopCapturer），返回真实像素尺寸供标注定位。
      if (captureScreen) {
        try {
          const shot = await captureScreen();
          return {
            contentId: `screen-${Date.now()}`,
            base64: shot.base64,
            width: shot.width,
            height: shot.height,
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }
      // 退化：内置浏览器页面截图（未注入屏幕捕获时）。
      if (!browser) {
        return { error: '截图不可用：主进程未注入屏幕捕获能力（electron.desktopCapturer）' };
      }
      try {
        const result = await browser.screenshot();
        return { contentId: result.contentId, base64: result.base64, width: 0, height: 0 };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });

    channel.handle('browser:saveAnnotated', (req: { base64: string; sessionId?: string }) => {
      const contentId = `annotated-${Date.now()}`;
      return { ok: true, contentId };
    });
  }

  /**
   * 事件扇出：引擎事件 → 对应会话的接收方（§10.2）。
   * 供 AgentService 的 `emit` 回调直接调用。
   */
  onEngineEvent = (event: AgentEvent): void => {
    const sessionId = resolveSessionId(event);
    this.send('engine:event', { sessionId, event });
    const ticket = approvalTicketFromEvent(sessionId, event);
    if (ticket) {
      this.send('session:status', { sessionId, state: 'pending_approval' });
    }
  };

  /** 会话状态推送（§10.3 session:status）。 */
  onSessionStatus = (sessionId: string, state: SessionState): void => {
    this.emitStatus(sessionId, state);
  };

  private emitStatus(sessionId: string, state: SessionState): void {
    this.send('session:status', { sessionId, state });
  }

  private send<C extends keyof SendChannelMap>(
    channel: C,
    payload: SendChannelMap[C],
  ): void {
    try {
      this.deps.channel.send(channel, payload);
    } catch {
      /* 接收方已销毁：静默丢弃（窗口关闭 ≠ 会话销毁） */
    }
  }

  /** 注册窗口占用（多窗口聚焦，§10.4）。 */
  attachWindow(sessionId: string): { alreadyOpen: boolean; focus: string | null } {
    const windowId = this.deps.recipientId ?? 'default';
    const res = this.deps.service.attachWindow(sessionId, windowId);
    if (!res.alreadyOpen) this.sessionWindow.set(sessionId, windowId);
    return res;
  }

  detachWindow(sessionId: string): void {
    const windowId = this.deps.recipientId ?? 'default';
    this.deps.service.detachWindow(sessionId, windowId);
    this.sessionWindow.delete(sessionId);
  }
}

/** 从任意事件解析归属会话 id（子智能体事件归父会话，便于 UI 分桶）。 */
function resolveSessionId(event: AgentEvent): string {
  const anyEv = event as unknown as Record<string, unknown>;
  if (typeof anyEv.sessionId === 'string') return anyEv.sessionId;
  if (typeof anyEv.parentSessionId === 'string') return anyEv.parentSessionId;
  return '*';
}
