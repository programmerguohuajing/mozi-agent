/**
 * LLMStream 实现：封装一个异步生成器（产出增量事件）与一个 finalize 回调（聚合结果）。
 */
import type { AssistantMessage } from '@mozi/shared';
import type { LLMStream, StreamEvent } from './types.js';

export class Stream implements LLMStream {
  constructor(
    private readonly gen: AsyncGenerator<StreamEvent>,
    private readonly buildResult: () => AssistantMessage,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield* this.gen;
  }

  result(): AssistantMessage {
    return this.buildResult();
  }
}
