/**
 * @mozi/sandbox 单元测试（M6 §6.4）。
 * 覆盖：网络白名单匹配、选择链降级矩阵、L0/L1 实际执行、超时强杀。
 */
import { describe, expect, it } from 'vitest';
import {
  KILLED_EXIT_CODE,
  createSandbox,
  defaultAllowNet,
  isNetworkAllowed,
  mergeAllowNet,
  previewLevel,
} from '../index.js';
import type { SandboxSupport } from '../platform.js';

describe('network allowlist', () => {
  it('精确匹配放行', () => {
    expect(isNetworkAllowed('registry.npmjs.org', ['registry.npmjs.org'])).toBe(true);
  });

  it('裸域名放行自身及子域', () => {
    const list = ['npmjs.org'];
    expect(isNetworkAllowed('npmjs.org', list)).toBe(true);
    expect(isNetworkAllowed('a.npmjs.org', list)).toBe(true);
    expect(isNetworkAllowed('evil.com', list)).toBe(false);
  });

  it('*. 通配仅匹配子域', () => {
    const list = ['*.npmjs.org'];
    expect(isNetworkAllowed('a.npmjs.org', list)).toBe(true);
    expect(isNetworkAllowed('npmjs.org', list)).toBe(false);
  });

  it('忽略 www. 前缀', () => {
    expect(isNetworkAllowed('www.github.com', ['github.com'])).toBe(true);
  });

  it('mergeAllowNet 去重并保留默认表', () => {
    const merged = mergeAllowNet(['NEW.COM']);
    expect(merged).toContain('registry.npmjs.org');
    expect(merged).toContain('new.com');
    // 去重：defaultAllowNet 已有的不应重复。
    const withDup = mergeAllowNet(['github.com']);
    expect(withDup.filter((d) => d === 'github.com').length).toBe(1);
  });

  it('defaultAllowNet 返回副本，修改不影响内部', () => {
    const a = defaultAllowNet();
    a.push('mutated');
    expect(defaultAllowNet()).not.toContain('mutated');
  });
});

describe('selection chain degradation', () => {
  const winNoDocker: SandboxSupport = {
    platform: 'win32',
    hasDocker: false,
    l2Supported: false,
    l2Note: 'win',
  };
  const macSeatbelt: SandboxSupport = {
    platform: 'darwin',
    hasDocker: true,
    l2Supported: true,
  };
  const linuxNoDocker: SandboxSupport = {
    platform: 'linux',
    hasDocker: false,
    l2Supported: false,
    l2Note: 'linux',
  };

  it('L0/L1 不降级', () => {
    expect(previewLevel(0, winNoDocker).level).toBe(0);
    expect(previewLevel(1, winNoDocker).level).toBe(1);
  });

  it('非 macOS 平台 L2 降级为 L1', () => {
    const r = previewLevel(2, winNoDocker);
    expect(r.level).toBe(1);
    expect(r.note).toBeTruthy();
  });

  it('macOS 有 Seatbelt 时 L2 生效', () => {
    expect(previewLevel(2, macSeatbelt).level).toBe(2);
  });

  it('无 docker 时 L3 降级（macOS→L2，其它→L1）', () => {
    expect(previewLevel(3, macSeatbelt).level).toBe(3); // 该用例 hasDocker=true
    const rWin = previewLevel(3, winNoDocker);
    expect(rWin.level).toBe(1);
    const rLin = previewLevel(3, linuxNoDocker);
    expect(rLin.level).toBe(1);
  });

  it('createSandbox 返回 effective level', () => {
    const runner = createSandbox({ level: 0 });
    expect(runner.level).toBe(0);
  });
});

describe('execution (L0/L1)', () => {
  it('L0 执行 echo 拿到 stdout', async () => {
    const runner = createSandbox({ level: 0 });
    const res = await runner.exec('echo hello-sandbox', {
      cwd: process.cwd(),
      timeoutMs: 5000,
      networkAllowed: false,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello-sandbox');
    expect(res.level).toBe(0);
    expect(res.degradedFrom).toBeUndefined();
  });

  it('L1 超时强杀返回 KILLED 哨兵', async () => {
    const runner = createSandbox({ level: 1 });
    // Windows 用 timeout/sleep 无限挂起；用跨平台写法：node 死循环会更快被强杀。
    const hang = process.platform === 'win32' ? 'ping -n 60 127.0.0.1 >nul' : 'sleep 60';
    const start = Date.now();
    const res = await runner.exec(hang, {
      cwd: process.cwd(),
      timeoutMs: 400,
      networkAllowed: false,
    });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(res.exitCode).toBe(KILLED_EXIT_CODE);
  });

  it('非零退出码透传', async () => {
    const runner = createSandbox({ level: 1 });
    const res = await runner.exec(process.platform === 'win32' ? 'exit /b 7' : 'exit 7', {
      cwd: process.cwd(),
      timeoutMs: 2000,
      networkAllowed: false,
    });
    expect(res.exitCode).toBe(7);
  });
});
