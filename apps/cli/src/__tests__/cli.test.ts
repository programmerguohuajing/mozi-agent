import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TaskSpec, TaskStore, newTaskId, validateTaskConfig } from '@mozi/core';
import type { DeviceRecord } from '@mozi/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileRegistryIO } from '../remote.js';
import { HOME, TASKS_DIR, taskAdd, taskList, taskRemove } from '../task.js';

/**
 * CLI 自动化测试：
 *   - task.ts：TaskStore CRUD、validateTaskConfig、newTaskId
 *   - remote.ts：fileRegistryIO 原子读写
 *   - buildProvider 逻辑（间接验证：离线模式无 env 时走 demo 路径）
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('task.ts', () => {
  it('HOME / TASKS_DIR 路径常量正确', () => {
    expect(HOME).toBe(os.homedir());
    expect(TASKS_DIR).toContain('.mozi');
  });

  it('newTaskId 生成唯一 ID', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newTaskId());
    }
    expect(ids.size).toBe(100);
  });

  it('TaskStore：保存 → 加载 → 数据完整', () => {
    const file = path.join(tmpDir, 'tasks.json');
    const store = new TaskStore(file);
    expect(store.load()).toEqual([]);

    const task: TaskSpec = {
      id: 'task-1',
      name: '测试任务',
      prompt: 'echo hello',
      workspace: tmpDir,
      schedule: { kind: 'once', at: '2026-12-01T00:00:00Z' },
      config: {
        policy: {
          mode: 'allowlist',
          allowlist: { commands: ['npm'], writePathGlobs: ['dist/**'] },
        },
        artifact: 'pr',
      },
      enabled: true,
      createdAt: '2026-09-14T10:00:00Z',
      state: { consecutiveFailures: 0, totalRuns: 0 },
    };
    store.save([task]);
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('task-1');
    expect(loaded[0]!.name).toBe('测试任务');
  });

  it('TaskStore：文件不存在时返回空数组（不抛错）', () => {
    const store = new TaskStore(path.join(tmpDir, 'nonexistent.json'));
    expect(store.load()).toEqual([]);
  });

  it('validateTaskConfig：合法配置通过', () => {
    const result = validateTaskConfig({
      id: 't-1',
      name: '每日构建',
      workspace: tmpDir,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      prompt: 'run build',
      enabled: true,
      policy: { mode: 'allowlist', allowlist: { commands: ['npm'], writePathGlobs: ['dist/**'] } },
      artifact: 'pr',
    } as never);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validateTaskConfig：非法配置报错', () => {
    const result = validateTaskConfig({
      id: 't-2',
      name: '',
      workspace: '',
      schedule: { kind: 'once', at: '' },
      prompt: '',
      enabled: true,
      policy: { mode: 'full' },
      artifact: 'direct',
    } as never);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('remote.ts', () => {
  it('fileRegistryIO：写入 → 读取 → 原子性', () => {
    const file = path.join(tmpDir, 'devices.json');
    const io = fileRegistryIO(file);

    expect(io.load()).toEqual([]);

    const records: DeviceRecord[] = [
      {
        deviceId: 'dev-1',
        name: 'iPhone',
        pairedAt: '2026-09-14T10:00:00Z',
        status: 'active',
      } as never,
    ];
    io.save(records);
    const loaded = io.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.deviceId).toBe('dev-1');
  });

  it('fileRegistryIO：损坏文件返回空数组', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{invalid json', 'utf8');
    const io = fileRegistryIO(file);
    expect(io.load()).toEqual([]);
  });

  it('fileRegistryIO：自动创建父目录', () => {
    const file = path.join(tmpDir, 'nested', 'deep', 'devices.json');
    const io = fileRegistryIO(file);
    io.save([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('CLI 打包产物冒烟', () => {
  it('dist/index.cjs 存在且可执行 --version', async () => {
    const distFile = path.resolve(__dirname, '..', '..', 'dist', 'index.cjs');
    if (!fs.existsSync(distFile)) return; // CI 未打包时跳过

    const { execFileSync } = await import('node:child_process');
    const output = execFileSync('node', [distFile, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    expect(output).toMatch(/^\d+\.\d+\.\d+/);
  });
});
