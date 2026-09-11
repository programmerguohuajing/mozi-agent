/**
 * 内存传输（测试桩，M8 §8.15）：不真正联网/起进程，由测试用例注入对端行为。
 */
import type { Disposable, JsonRpcMessage, McpTransport, TransportKind } from './types.js';

export class InMemoryTransport implements McpTransport {
  readonly kind: TransportKind = 'stdio';
  private handlers = new Set<(msg: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private started = false;
  closed = false;

  /** 测试侧：模拟对端发来的消息（通知 / 响应）。 */
  push(msg: JsonRpcMessage): void {
    for (const h of this.handlers) h(msg);
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }

  onClose(handler: (reason: string) => void): Disposable {
    this.closeHandlers.add(handler);
    return { dispose: () => this.closeHandlers.delete(handler) };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    // 交给对端注入逻辑（通过 install 回调），这里仅记录 started。
    void this.started;
    void message;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const h of this.closeHandlers) h('closed');
  }
}
