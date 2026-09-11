/**
 * 审批网关（M1 §1.4）：引擎发出 tool.approval.required 后等待裁决。
 * 交互式网关由 UI 通过 resolve() 应答；测试可注入自动网关。
 */
import type { ApprovalReason, ToolCall } from '@mozi/shared';

export interface ApprovalGateway {
  request(call: ToolCall, reason: ApprovalReason): Promise<'allow' | 'deny'>;
  resolve(callId: string, decision: 'allow' | 'deny'): void;
}

export class InteractiveApprovalGateway implements ApprovalGateway {
  private readonly pending = new Map<string, (decision: 'allow' | 'deny') => void>();
  /** 早期裁决缓存：resolve 先于 request 到达时（如冒泡事件同步送达），记录后立即生效。 */
  private readonly early = new Map<string, 'allow' | 'deny'>();

  request(call: ToolCall): Promise<'allow' | 'deny'> {
    const early = this.early.get(call.id);
    if (early) {
      this.early.delete(call.id);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      this.pending.set(call.id, resolve);
    });
  }

  resolve(callId: string, decision: 'allow' | 'deny'): void {
    const resolver = this.pending.get(callId);
    if (resolver) {
      this.pending.delete(callId);
      resolver(decision);
      return;
    }
    // 尚未发起 request：缓存，待 request 时立即消费（避免同步竞态）。
    this.early.set(callId, decision);
  }
}

/** 测试 / 非交互模式用：统一裁决所有 ask。 */
export function autoApproveGateway(decision: 'allow' | 'deny' = 'allow'): ApprovalGateway {
  return {
    request: async () => decision,
    resolve: () => {},
  };
}
