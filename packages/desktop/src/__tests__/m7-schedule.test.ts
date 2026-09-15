import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskSchedulerHost } from '@mozi/desktop';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 定时任务宿主测试（M4.5 / M13 §13.4 / §13.7 / §13.10）：
 *   - create 校验（名称 / 指令 / 工作区 / cron）与默认配置落盘
 *   - toggle 启停 / remove 删除（含缺失任务错误路径）
 *   - onTaskEvent 事件（创建 / 启停 / 删除均触发）
 *   - runNow 立即执行：真实 headless 链路（ScriptedProvider）→ lastStatus=success
 *   - runNow 工作区缺失 → 失败记录（不抛异常）
 *   - tick 到期触发：clock 拨动 → 到期任务执行并更新状态
 *   - 数据持久化：重建 host 后任务仍在
 */

let dir: string;
let wsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-tasks-'));
  wsDir = path.join(dir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

/** scripted provider：无人值守任务直接输出文本（无审批请求 → 全部通过）。 */
function makeRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(
    new ScriptedProvider([], 'scripted', 'scripted-model', {
      '*': [{ content: '任务完成。' }],
    }),
  );
  reg.alias('deepseek-chat', 'scripted');
  reg.alias('executor', 'scripted');
  return reg;
}

function makeHost(
  opts: { clock?: () => Date; onTaskEvent?: () => void; tickMs?: number } = {},
): TaskSchedulerHost {
  return new TaskSchedulerHost({
    dataDir: path.join(dir, 'data'),
    providers: makeRegistry(),
    ...opts,
  });
}

const BASE = { name: '晨报', cron: '0 9 * * *', prompt: '写一份当日任务', workspace: '' as string };

describe('create 校验与默认配置', () => {
  it('名称 / 指令 / 工作区 / cron 缺一不可；全部失败时不落盘', () => {
    const host = makeHost();
    expect(host.create({ ...BASE, name: '  ', workspace: wsDir }).ok).toBe(false);
    expect(host.create({ ...BASE, name: '', workspace: wsDir }).error ?? '').toContain('任务名称');
    expect(host.create({ ...BASE, prompt: '', workspace: wsDir }).error ?? '').toContain(
      '任务指令',
    );
    expect(host.create({ ...BASE, workspace: ' ' }).error ?? '').toContain('工作区');
    expect(host.create({ ...BASE, cron: 'not a cron', workspace: wsDir }).error ?? '').toContain(
      'cron',
    );
    expect(host.list()).toHaveLength(0);
  });

  it('合法创建：视图字段完整，默认 policy=readonly / artifact=report-only，notify 缺省不写', () => {
    const host = makeHost();
    const r = host.create({ ...BASE, workspace: wsDir });
    expect(r.ok).toBe(true);
    const t = r.task!;
    expect(t.name).toBe('晨报');
    expect(t.cron).toBe('0 9 * * *');
    expect(t.enabled).toBe(true);
    expect(t.lastStatus).toBe('never');
    expect(t.nextRun).toBeTruthy();
    expect(t.workspace).toBe(wsDir);

    const stored = host.store.get(t.id)!;
    expect(stored.config.policy.mode).toBe('readonly');
    expect(stored.config.artifact).toBe('report-only');
    expect(stored.notifications).toBeUndefined();
  });

  it('notify=true 写入桌面通知；自定义 policy/model 生效', () => {
    const host = makeHost();
    const r = host.create({
      ...BASE,
      workspace: wsDir,
      notify: true,
      policyMode: 'allowlist',
      model: 'gpt-4o',
    });
    expect(r.ok).toBe(true);
    const stored = host.store.get(r.task!.id)!;
    expect(stored.notifications?.desktop).toBe(true);
    expect(stored.config.policy.mode).toBe('allowlist');
    expect(stored.config.model).toBe('gpt-4o');
  });
});

describe('toggle / remove / 事件', () => {
  it('toggle 启停翻转；缺失任务明确报错', () => {
    const host = makeHost();
    const id = host.create({ ...BASE, workspace: wsDir }).task!.id;
    expect(host.toggle(id).task!.enabled).toBe(false);
    expect(host.toggle(id).task!.enabled).toBe(true);
    expect(host.toggle('missing-id').ok).toBe(false);
  });

  it('remove 删除后列表为空；重复删除报错', () => {
    const host = makeHost();
    const id = host.create({ ...BASE, workspace: wsDir }).task!.id;
    expect(host.remove(id).ok).toBe(true);
    expect(host.list()).toHaveLength(0);
    expect(host.remove(id).ok).toBe(false);
  });

  it('create / toggle / remove 均触发 onTaskEvent', () => {
    let calls = 0;
    const host = makeHost({
      onTaskEvent: () => {
        calls += 1;
      },
    });
    const r = host.create({ ...BASE, workspace: wsDir });
    host.toggle(r.task!.id);
    host.remove(r.task!.id);
    expect(calls).toBe(3);
  });
});

describe('runNow 立即执行（headless 链路）', () => {
  it('正常执行 → lastStatus=success 且事件触发', async () => {
    let calls = 0;
    const host = makeHost({
      onTaskEvent: () => {
        calls += 1;
      },
    });
    const id = host.create({ ...BASE, workspace: wsDir }).task!.id;
    const res = await host.runNow(id);
    expect(res.ok).toBe(true);
    const view = host.list().find((t) => t.id === id)!;
    expect(view.lastStatus).toBe('success');
    // create(1) + runNow 开始(1) + 完成(1) + finally(1)
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(host.isRunning(id)).toBe(false);
  });

  it('工作区缺失 → 失败记录写入（执行链不抛错）', async () => {
    const host = makeHost();
    const id = host.create({ ...BASE, workspace: wsDir }).task!.id;
    fs.rmSync(wsDir, { recursive: true, force: true });
    const res = await host.runNow(id);
    expect(res.ok).toBe(true);
    const view = host.list().find((t) => t.id === id)!;
    expect(view.lastStatus).toBe('failed');
  });

  it('任务不存在 → 明确错误', async () => {
    const host = makeHost();
    const res = await host.runNow('missing');
    expect(res.ok).toBe(false);
    expect(res.error ?? '').toContain('任务不存在');
  });
});

describe('tick 到期触发', () => {
  it('cron 到期 → triggered 并更新 lastStatus=success', async () => {
    let now = new Date('2026-07-14T00:59:00.000Z');
    const host = makeHost({ clock: () => now });
    const id = host.create({ ...BASE, cron: '* * * * *', workspace: wsDir }).task!.id;

    now = new Date('2026-07-14T01:00:00.000Z');
    const res = await host.tick();
    expect(res.triggered).toContain(id);
    expect(res.errors).toHaveLength(0);
    const view = host.list().find((t) => t.id === id)!;
    expect(view.lastStatus).toBe('success');
    expect(view.nextRun).toBe('2026-07-14T01:01:00.000Z');
  });

  it('未到期 tick 不触发', async () => {
    const host = makeHost({ clock: () => new Date('2026-07-14T00:00:00.000Z') });
    const id = host.create({ ...BASE, workspace: wsDir }).task!.id;
    const res = await host.tick(); // 09:00 才到期
    expect(res.triggered).not.toContain(id);
    expect(res.errors).toHaveLength(0);
  });
});

describe('生命周期与持久化', () => {
  it('start / stop 幂等，不抛错', async () => {
    const host = makeHost({ tickMs: 60_000 });
    host.start();
    host.start(); // 幂等：不会重复起 timer
    await new Promise((r) => setTimeout(r, 50)); // 等首次立即 tick 落定
    host.stop();
    host.stop(); // 幂等
  });

  it('数据持久化：重建 host 后任务仍在（TaskStore 落盘）', () => {
    const dataDir = path.join(dir, 'data');
    const h1 = new TaskSchedulerHost({ dataDir, providers: makeRegistry() });
    const id = h1.create({ ...BASE, workspace: wsDir }).task!.id;
    const h2 = new TaskSchedulerHost({ dataDir, providers: makeRegistry() });
    const ids = h2.list().map((t) => t.id);
    expect(ids).toContain(id);
    expect(h2.list().find((t) => t.id === id)?.name).toBe('晨报');
  });
});
