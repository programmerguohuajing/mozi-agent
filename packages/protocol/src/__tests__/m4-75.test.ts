import {
  DeviceRegistry,
  PairingService,
  RemoteNode,
  approvalPermitted,
  externalizeAttachment,
  generateIdentityKeys,
  hashToken,
  openFrom,
  packEnvelope,
  sealTo,
  signMessage,
  verifySignature,
} from '@mozi/protocol';
import { RelayRouter } from '@mozi/relay-server';
import { describe, expect, it } from 'vitest';
/**
 * M4.75 移动端与远程访问测试（M14 §14.2-14.13）：
 * 设备权限矩阵 / 配对（TTL·单次·暴力锁定）/ 设备注册表 / E2E 加密（P-256+Ed25519）/
 * 中继路由（零内容信封）/ 节点协议全链路（认证、门禁、幂等、事件重放、附件外置、吊销）。
 */

const DEFAULT_PERMS = {
  viewSessions: true,
  viewWorkspaceFiles: false,
  sendMessage: true,
  approveRequests: 'standard',
  triggerTasks: true,
  manageDevices: false,
  changePolicy: false,
};

function memRegistry() {
  let records: Parameters<DeviceRegistry['register']>[0][] = [];
  return new DeviceRegistry({
    load: () => records,
    save: (r) => {
      records = r;
    },
  });
}

describe('M4.75 设备权限矩阵（§14.5）', () => {
  it('standard：safe/network 可批、high 仅 defer', () => {
    const p = { approveRequests: 'standard' as const };
    expect(approvalPermitted(p, 'safe')).toBe('approve');
    expect(approvalPermitted(p, 'network')).toBe('approve');
    expect(approvalPermitted(p, 'high')).toBe('defer');
  });
  it('all 可批 high；none 一律拒', () => {
    expect(approvalPermitted({ approveRequests: 'all' }, 'high')).toBe('approve');
    expect(approvalPermitted({ approveRequests: 'none' }, 'safe')).toBe('reject');
  });
});

describe('M4.75 配对（§14.4）', () => {
  it('6 位码首次可用、单次使用', () => {
    const ps = new PairingService('node-1');
    const { code } = ps.createPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(ps.verify(code).ok).toBe(true);
    expect(ps.verify(code).ok).toBe(false);
    expect(ps.verify('000000').ok).toBe(false);
  });
  it('TTL 过期拒绝', () => {
    let current = Date.now();
    const ps = new PairingService('node-1', { now: () => current });
    const { code } = ps.createPairing();
    current += 10 * 60_000;
    expect(ps.verify(code).ok).toBe(false);
  });
  it('暴力锁定（10 次失败）', () => {
    const ps = new PairingService('node-1');
    for (let i = 0; i < 10; i++) ps.recordFailure();
    expect(ps.verify('123456').ok).toBe(false);
  });
});

describe('M4.75 设备注册表（§14.4）', () => {
  it('tokenHash 校验不存明文 + 吊销 + rename', () => {
    const reg = memRegistry();
    const token = 'dev-token-abc';
    reg.register({ deviceId: 'dev-1', name: 'iPhone', platform: 'ios', pubKey: 'pk', tokenHash: hashToken(token), permissions: DEFAULT_PERMS, pairedAt: new Date().toISOString() });
    expect(reg.verifyToken('dev-1', hashToken(token))).toBe(true);
    expect(reg.verifyToken('dev-1', hashToken('x'))).toBe(false);
    reg.revoke('dev-1');
    expect(reg.verifyToken('dev-1', hashToken(token))).toBe(false);
    const r2 = memRegistry();
    r2.register({ deviceId: 'd', name: 'A', platform: 'p', pubKey: 'k', tokenHash: 'h', permissions: DEFAULT_PERMS, pairedAt: 'now' });
    expect(r2.rename('d', 'B')).toBe(true);
    expect(r2.get('d').name).toBe('B');
  });
});

describe('M4.75 E2E 加密（P-256 + AES-GCM + Ed25519）', () => {
  it('往返解密 + 篡改被拒 + 信封零内容 + 签名防伪', () => {
    const node = generateIdentityKeys();
    const device = generateIdentityKeys();
    const plain = '{"channel":"run:start","params":{"sessionId":"s1"}}';
    const box = sealTo(node.encPriv, device.encPubX, device.encPubY, plain);
    expect(openFrom(device.encPriv, node.encPubX, node.encPubY, box).toString('utf8')).toBe(plain);
    expect(() => openFrom(device.encPriv, node.encPubX, node.encPubY, { ...box, ct: box.ct.slice(0, -4) + 'AAAA' })).toThrow();
    const env = packEnvelope('node-1', 'dev-1', box, plain.length);
    expect(env.len).toBe(plain.length);
    expect(JSON.stringify(env)).not.toContain('run:start');
    const sig = signMessage(node.sigPub, node.sigPriv, 'hello');
    expect(verifySignature(node.sigPub, 'hello', sig)).toBe(true);
    expect(verifySignature(node.sigPub, 'hello!', sig)).toBe(false);
    expect(verifySignature(node.sigPub, 'hello', 'bad')).toBe(false);
  });
});

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
    expect(e.len).toBe(10);
    expect(JSON.stringify(e)).not.toContain('cipher');
  });
});

describe('M4.75 RemoteNode 协议全链路', () => {
  it('认证 → 门禁 → 幂等 → 事件扇出 → 附件外置 → 吊销', async () => {
    const out: unknown[] = [];
    const transport = {
      send: (f: unknown) => out.push(f),
      close: (code?: number) => {
        out.push({ t: 'closed', code });
      },
    };
    const reg = memRegistry();
    const pairing = new PairingService('node-1');
    const { code } = pairing.createPairing();
    const node = new RemoteNode({ registry: reg, pairing, transport });
    const calls = { runStart: 0 };
    node.handle('run:start', () => {
      calls.runStart += 1;
      return { accepted: true, runId: 'r1' };
    });
    node.handle('session:list', () => [{ id: 's1' }]);
    node.handle('config:set', () => ({ ok: true }));
    node.handle('approval:resolve', () => ({ ok: true }));
    node.handle('task:run', () => ({ ok: true }));

    const last = () => out[out.length - 1] as { t: string; error?: { code: string }; ok?: unknown; deviceId?: string; token?: string };

    await node.onFrame({ t: 'invoke', id: 'i0', channel: 'run:start', params: {} });
    expect(last().error!.code).toBe('ERR_AUTH');

    await node.onFrame({ t: 'pair', code, deviceName: 'iPhone', platform: 'ios', pubKey: 'pk' });
    const pairOk = last();
    expect(pairOk.t).toBe('pair-ok');
    await node.onFrame({ t: 'auth', deviceId: pairOk.deviceId!, tokenHash: hashToken(pairOk.token!) });
    expect(last().t).toBe('auth-ok');
    await node.onFrame({ t: 'invoke', id: 'i1', channel: 'run:start', params: {} });
    expect((last().ok as { runId: string }).runId).toBe('r1');

    await node.onFrame({ t: 'invoke', id: 'i2', channel: 'config:set', params: {} });
    expect(last().error!.code).toBe('ERR_FORBIDDEN');
    await node.onFrame({ t: 'invoke', id: 'i3', channel: 'approval:resolve', params: { risk: 'high', decision: 'allow' } });
    expect(last().error!.code).toBe('ERR_DEFER');
    await node.onFrame({ t: 'invoke', id: 'i4', channel: 'approval:resolve', params: { risk: 'safe', decision: 'allow' } });
    expect((last().ok as { ok: boolean }).ok).toBe(true);

    const before = calls.runStart;
    await node.onFrame({ t: 'invoke', id: 'i5', channel: 'run:start', params: {}, requestId: 'rid-1' });
    const first = out.length - 1;
    await node.onFrame({ t: 'invoke', id: 'i6', channel: 'run:start', params: {}, requestId: 'rid-1' });
    expect(out[first]).toEqual(out[out.length - 1]);
    expect(calls.runStart).toBe(before + 1);

    const beforeEvents = out.length;
    node.publishEvent('s1', { type: 'message.completed' });
    node.publishEvent('s1', { type: 'tool.completed' });
    expect(out.length).toBe(beforeEvents + 2);
    const firstSeq = (out[beforeEvents] as { seq: number }).seq;
    const replayBefore = out.length;
    await node.onFrame({ t: 'attach', sessionId: 's1', lastEventId: firstSeq });
    expect(out.length).toBe(replayBefore + 1);

    const big = externalizeAttachment({ content: 'y'.repeat(9_000) }, (data, kind) => ({ contentId: 'att_1', kind, totalChunks: 2, chunkSize: 8_000 }));
    expect(big.externalized).toBe(true);
    expect(big.ref!.kind).toBe('content');
    const small = externalizeAttachment({ content: 'hi' }, () => null);
    expect(small.externalized).toBe(false);

    node.revokeCurrent();
    await node.onFrame({ t: 'invoke', id: 'i7', channel: 'session:list', params: {} });
    expect(last().error!.code).toBe('ERR_AUTH');
  });
});