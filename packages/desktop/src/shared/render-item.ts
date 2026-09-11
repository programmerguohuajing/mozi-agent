/**
 * RenderItem 模型（M9/M10/M14 共享渲染语义，§10.5② / §14.6）。
 *
 * 「渲染模型与 M9/M10 共享同一 RenderItem 语义」——CLI、桌面、移动端
 * 消费同一份事件流，产出同一份 RenderItem 列表，只是渲染器不同。
 */
import type { AgentEvent, ApprovalReason, DisplayPayload, ToolCall, TokenUsage } from '@mozi/shared';

export type RenderItem =
  | { kind: 'user'; id: string; text: string; ts: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; ts: string }
  | { kind: 'reasoning'; id: string; text: string; ts: string }
  | { kind: 'tool'; id: string; callId: string; name: string; args: unknown; state: 'requested' | 'running' | 'done' | 'error'; summary?: string; display?: DisplayPayload; durationMs?: number; ts: string }
  | { kind: 'approval'; id: string; callId: string; sessionId: string; call: ToolCall; reason: ApprovalReason; resolved?: 'allow' | 'deny'; agentType?: string; subSessionId?: string; ts: string }
  | { kind: 'todo'; id: string; tasks: Array<{ id: string; title: string; status: string }>; ts: string }
  | { kind: 'compacted'; id: string; removedTurns: number; savedTokens: number; summary: string; ts: string }
  | { kind: 'subagent'; id: string; subSessionId: string; agentType: string; state: 'started' | 'queued' | 'progress' | 'completed' | 'failed'; step?: number; maxSteps?: number; currentTool?: string; summary?: string; error?: string; ts: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; ts: string }
  | { kind: 'usage'; id: string; usage: TokenUsage; steps?: number; ts: string };

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 重置 id 序列（测试确定性）。 */
export function resetRenderIdSeq(): void {
  seq = 0;
}

/**
 * 事件 → RenderItem 归约（纯函数，可单测 / 快照）。
 * streaming 合并由调用方（store）负责：message.delta 追加到最后一条 assistant。
 */
export function eventToRenderItems(event: AgentEvent): RenderItem[] {
  const ts = event.ts;
  switch (event.type) {
    case 'turn.started':
      return [{ kind: 'user', id: nextId('user'), text: event.input, ts }];
    case 'message.delta':
      return [{ kind: 'assistant', id: 'stream', text: event.text, streaming: true, ts }];
    case 'message.completed': {
      const items: RenderItem[] = [];
      if (event.message.reasoning) {
        items.push({ kind: 'reasoning', id: nextId('reason'), text: event.message.reasoning, ts });
      }
      if (event.message.content) {
        items.push({
          kind: 'assistant',
          id: nextId('asst'),
          text: event.message.content,
          streaming: false,
          ts,
        });
      }
      if (event.message.toolCalls?.length) {
        for (const call of event.message.toolCalls) {
          items.push({
            kind: 'tool',
            id: nextId('tool'),
            callId: call.id,
            name: call.name,
            args: call.arguments,
            state: 'requested',
            ts,
          });
        }
      }
      return items;
    }
    case 'tool.started':
      return [];
    case 'tool.completed':
      return [
        {
          kind: 'tool',
          id: 'update',
          callId: event.callId,
          name: '',
          args: undefined,
          state: event.result.isError ? 'error' : 'done',
          summary: event.result.content.slice(0, 300),
          ...(event.result.display ? { display: event.result.display } : {}),
          ...(event.result.meta?.durationMs != null ? { durationMs: event.result.meta.durationMs } : {}),
          ts,
        },
      ];
    case 'tool.approval.required':
      return [
        {
          kind: 'approval',
          id: nextId('appr'),
          callId: event.call.id,
          sessionId: '',
          call: event.call,
          reason: event.reason,
          ts,
        },
      ];
    case 'context.compacted':
      return [
        {
          kind: 'compacted',
          id: nextId('cmp'),
          removedTurns: event.removedTurns,
          savedTokens: event.savedTokens,
          summary: event.summary,
          ts,
        },
      ];
    case 'subagent.started':
      return [
        {
          kind: 'subagent',
          id: nextId('sub'),
          subSessionId: event.subSessionId,
          agentType: event.agentType,
          state: 'started',
          ts,
        },
      ];
    case 'subagent.queued':
      return [
        {
          kind: 'subagent',
          id: 'update',
          subSessionId: event.subSessionId,
          agentType: '',
          state: 'queued',
          step: event.queuePosition,
          ts,
        },
      ];
    case 'subagent.progress':
      return [
        {
          kind: 'subagent',
          id: 'update',
          subSessionId: event.subSessionId,
          agentType: '',
          state: 'progress',
          ...(event.currentTool ? { currentTool: event.currentTool } : {}),
          step: event.step,
          maxSteps: event.maxSteps,
          ts,
        },
      ];
    case 'subagent.approval.required':
      return [
        {
          kind: 'approval',
          id: nextId('appr'),
          callId: event.callId,
          sessionId: '',
          call: event.call,
          reason: event.reason,
          agentType: event.agentType,
          subSessionId: event.subSessionId,
          ts,
        },
      ];
    case 'subagent.completed':
      return [
        {
          kind: 'subagent',
          id: 'update',
          subSessionId: event.subSessionId,
          agentType: '',
          state: 'completed',
          summary: event.summary,
          step: event.steps,
          ts,
        },
      ];
    case 'subagent.failed':
      return [
        {
          kind: 'subagent',
          id: 'update',
          subSessionId: event.subSessionId,
          agentType: '',
          state: 'failed',
          error: `${event.error.code}: ${event.error.message}`,
          ts,
        },
      ];
    case 'turn.completed':
      return [
        {
          kind: 'usage',
          id: nextId('usage'),
          usage: event.usage,
          steps: event.steps,
          ts,
        },
      ];
    case 'token.usage':
      // 实时 token 增量（provider 流级粒度，比 turn.completed 更细）——不生成卡片，
      // 由 store 直接更新 SessionView.usage（供 TokenCounter 实时展示）。
      return [];
    case 'cost.warning':
      return [
        { kind: 'notice', id: nextId('cost-warn'), level: 'warn', text: `💰 ${event.message}`, ts },
      ];
    case 'error':
      return [
        { kind: 'notice', id: nextId('err'), level: 'error', text: `${event.error.code}: ${event.error.message}`, ts },
      ];
    default:
      return [];
  }
}

/** 合并 todo 工具结果为 todo 卡片（§10.5② 计划面板）。 */
export function todoItemFromResult(
  result: string,
  tasks: Array<{ id: string; title: string; status: string }>,
  ts: string,
): RenderItem {
  void result;
  return { kind: 'todo', id: nextId('todo'), tasks, ts };
}
