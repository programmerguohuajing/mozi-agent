import { describe, expect, it } from 'vitest';
import { RelayRouter } from '../relay.js';
/**
 * 中继路由（零内容信封）测试（M14 §14.9）。
 * 原在 @mozi/protocol 的测试中 —— 但 protocol 依赖本包（build 依赖），
 * 反向 import 造成 turbo 环依赖（protocol#build ⇄ relay-server#build），
 * 故移到本包内自测（测试中继自身行为无需 protocol）。
 */

describe('M4.75 中继路由（§14.9）', () => {
  it('在线转发 / 离线未交付 / 日志只记路由头', () => {
    const router = new RelayRouter({ logging: false });
    const got: unknown[] = [];
    router.register({ id: 'node-1', deliver: (e) => got.push(e) });
    const env = { from: 'dev-1', to: 'node-1', ts: 1, box: { iv: 'i', tag: 't', ct: 'c' }, len: 3 };
    expect(router.route(env).delivered).toBe(true);
    expect(got.length).toBe(1);
    expect(router.entries().length).toBe(0);
    expect(router.route({ ...env, to: 'ghost' }).delivered).toBe(false);
    const r2 = new RelayRouter({ logging: true });
    r2.register({ id: 'n', deliver: () => {} });
    r2.route({ from: 'a', to: 'n', ts: 1, box: { iv: 'i', tag: 't', ct: 'c' }, len: 10 });
    const e = r2.entries()[0];
    expect(e?.len).toBe(10);
    expect(JSON.stringify(e)).not.toContain('cipher');
  });
});
