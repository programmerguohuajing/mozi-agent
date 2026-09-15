/**
 * OpenAICompatibleProvider 防御性行为测试（零依赖网络，mock fetch）。
 * 覆盖：
 *   - 非 SSE 响应（200 HTML）→ 抛友好错误而非静默产出空回复（"发完即完成"修复）
 *   - 自动路由（model 为空）：请求体不带 model 字段、无 key 不带 Authorization
 *   - id 覆盖（registry 注册名与上游 model 解耦）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../openai.js';
import type { StreamEvent } from '../types.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 替换全局 fetch：固定返回指定状态码与响应体，并记录调用。 */
function mockFetch(
  status: number,
  body: string,
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? ({} as RequestInit) });
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  return { calls };
}

async function collectStream(provider: OpenAICompatibleProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of provider.chat({ messages: [] })) out.push(ev);
  return out;
}

describe('OpenAICompatibleProvider 防御性解析', () => {
  it('非 SSE 响应（200 HTML，如网关 Dashboard）→ 抛友好错误而非静默空回复', async () => {
    mockFetch(200, '<!DOCTYPE html><html><body>Dashboard</body></html>');
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:3000/v1',
      model: 'some-model',
      apiKey: () => 'k',
    });
    await expect(collectStream(p)).rejects.toThrow(/未返回有效的流式响应/);
  });

  it('自动路由（model 为空）：请求体不带 model 字段，无 key 不带 Authorization', async () => {
    const { calls } = mockFetch(
      200,
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:3000/v1',
      model: '', // 自动路由
      id: 'freellmapi',
      apiKey: () => undefined,
    });
    // registry 注册名使用注入的 id，而非空 model
    expect(p.id).toBe('freellmapi');

    const events = await collectStream(p);
    expect(events.some((e) => e.type === 'text.delta')).toBe(true);

    const init = calls[0]!.init;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect('model' in body).toBe(false);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('正常 SSE 流：model 字段照常携带', async () => {
    const { calls } = mockFetch(
      200,
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:3000/v1',
      model: 'deepseek-v3',
      apiKey: () => 'sk-test',
    });
    expect(p.id).toBe('deepseek-v3');
    await collectStream(p);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-v3');
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
  });
});
