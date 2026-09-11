/**
 * 进程内直连传输（§14.3 三传输适配器之一）。
 *
 * 与 Electron IPC / WSS 共用同一 channel 语义；用于：
 *   - 单元测试与运行时验证（无需真实 Electron）
 *   - TUI 进程内直连（可选）
 *
 * 行为契约与 Electron IPC 完全一致：invoke 抛出 handler 的异常；send 按注册顺序同步分发。
 */
import type {
  ChannelClient,
  ChannelServer,
  InvokeChannel,
  InvokeChannels,
  MaybePromise,
  SendChannel,
  SendChannelMap,
} from './index.js';

type AnyHandler = (payload: never) => unknown;

export class LoopbackChannel implements ChannelServer, ChannelClient {
  private readonly handlers = new Map<string, (payload: unknown) => unknown>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** 记录的 invoke 调用（诊断 / 断言用）。 */
  readonly calls: Array<{ channel: string; payload: unknown }> = [];
  /** 记录的 send 推送（诊断 / 断言用）。 */
  readonly sent: Array<{ channel: string; payload: unknown }> = [];

  handle<C extends InvokeChannel>(
    channel: C,
    handler: (
      payload: Parameters<InvokeChannels[C]>[0],
    ) => MaybePromise<ReturnType<InvokeChannels[C]>>,
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(`channel already handled: ${channel}`);
    }
    this.handlers.set(channel, handler as AnyHandler as (payload: unknown) => unknown);
  }

  /** 覆盖注册（重连 / 热更新场景）。 */
  replace<C extends InvokeChannel>(
    channel: C,
    handler: (
      payload: Parameters<InvokeChannels[C]>[0],
    ) => MaybePromise<ReturnType<InvokeChannels[C]>>,
  ): void {
    this.handlers.set(channel, handler as AnyHandler as (payload: unknown) => unknown);
  }

  send<C extends SendChannel>(channel: C, payload: SendChannelMap[C]): void {
    this.sent.push({ channel, payload });
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }

  invoke<C extends InvokeChannel>(
    channel: C,
    payload: Parameters<InvokeChannels[C]>[0],
  ): Promise<Awaited<ReturnType<InvokeChannels[C]>>> {
    this.calls.push({ channel, payload });
    const handler = this.handlers.get(channel);
    if (!handler) {
      return Promise.reject(new Error(`no handler for channel: ${channel}`));
    }
    try {
      return Promise.resolve(handler(payload)) as Promise<Awaited<ReturnType<InvokeChannels[C]>>>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  on<C extends SendChannel>(
    channel: C,
    listener: (payload: SendChannelMap[C]) => void,
  ): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    const fn = listener as (payload: unknown) => void;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  /** 已注册 handler 的通道名。 */
  handledChannels(): string[] {
    return [...this.handlers.keys()];
  }
}
