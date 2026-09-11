/**
 * ProviderRegistry（M4 §4.7）：按 modelId 解析 Provider，并做能力协商。
 */
import { ErrorCodes, MoziError } from '@mozi/shared';
import type { LLMProvider } from './types.js';

export interface ProviderMeta {
  id: string;
  model: string;
}

export class ProviderRegistry {
  private byModel = new Map<string, LLMProvider>();
  private aliases = new Map<string, string>(); // alias -> model id

  register(provider: LLMProvider): this {
    this.byModel.set(provider.id, provider);
    return this;
  }

  /** 注册别名（如把 deepseek-chat 同时映射到某个 provider 的 id）。 */
  alias(alias: string, modelId: string): this {
    this.aliases.set(alias, modelId);
    return this;
  }

  resolve(modelId: string): LLMProvider {
    const key = this.aliases.get(modelId) ?? modelId;
    const p = this.byModel.get(key);
    if (!p)
      throw new MoziError(
        ErrorCodes.ERR_PROVIDER_UNAVAILABLE,
        `no provider registered for model '${modelId}'`,
      );
    return p;
  }

  list(): ProviderMeta[] {
    return [...this.byModel.values()].map((p) => ({ id: p.id, model: p.id }));
  }
}
