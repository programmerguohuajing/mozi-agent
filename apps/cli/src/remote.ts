/**
 * 远程访问 CLI（M4.75 / M14 §14.11）：mozi serve（headless 远程服务）+ mozi device 命令族。
 * 真实 WSS 传输依赖 ws 依赖（用户 pnpm i 后启用）；无依赖环境下提供配对/注册/吊销全功能。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry, PairingService, type DeviceRecord } from '@mozi/protocol';

const DEVICES_FILE = process.env.MOZI_DEVICES_FILE ?? path.join(os.homedir(), '.mozi', 'devices.json');
const NODE_ID = 'mozi-node';

/** 文件式注册表 IO（原子写）。 */
export function fileRegistryIO(file: string): { load(): DeviceRecord[]; save(r: DeviceRecord[]): void } {
  return {
    load(): DeviceRecord[] {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceRecord[];
      } catch {
        return [];
      }
    },
    save(records: DeviceRecord[]): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    },
  };
}

export function openRegistry(): DeviceRegistry {
  return new DeviceRegistry(fileRegistryIO(DEVICES_FILE));
}

/** 生成配对码（终端/QR 显示；5 分钟有效、单次使用）。 */
export function pairDevice(): { code: string; ttlMs: number } {
  return new PairingService(NODE_ID).createPairing();
}

export function deviceList(): DeviceRecord[] {
  return openRegistry().list();
}

export function deviceRevoke(deviceId: string): boolean {
  return openRegistry().revoke(deviceId);
}

export function deviceRename(deviceId: string, name: string): boolean {
  return openRegistry().rename(deviceId, name);
}

/** serve：headless 远程服务入口（真实 WSS 需 ws 依赖；此处输出配对码进入控制台模式）。 */
export async function serve(opts: { port?: number; lan?: boolean; relay?: string }): Promise<void> {
  const port = opts.port ?? 7777;
  const { code, ttlMs } = pairDevice();
  const lines = [
    '[mozi serve] 远程服务（演示/配置模式）',
    `  端口：${port}${opts.lan ? '（LAN 直连）' : ''}${opts.relay ? `（经中继 ${opts.relay}）` : ''}`,
    `  配对码：${code}（${Math.round(ttlMs / 60_000)} 分钟有效，单次使用）`,
    `  设备注册表：${DEVICES_FILE}`,
    '',
    '  说明：真实 WSS 传输需 `pnpm add ws` 后由桌面/Expo 客户端接入；',
    '  本进程提供配对与设备生命周期管理（mozi device list/revoke/rename）。',
  ];
  console.log(lines.join('\n'));
  // 保持进程存活等待配对（演示）。
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ttlMs);
    timer.unref?.();
  });
}

/** CLI 命令注册（commander）。 */
export function registerRemoteCommands(program: import('commander').Command): void {
  const remote = program.command('device').description('远程设备与配对（M4.75）');

  remote.command('pair').description('生成配对码（5 分钟有效，单次使用）').action(() => {
    const { code, ttlMs } = pairDevice();
    console.log(`配对码：${code}（${Math.round(ttlMs / 60_000)} 分钟有效，单次使用）`);
  });

  remote.command('list').description('设备列表').action(() => {
    const devices = deviceList();
    if (!devices.length) {
      console.log('（无设备）');
      return;
    }
    for (const d of devices) {
      console.log(
        `${d.deviceId}  ${d.name.padEnd(16)} ${d.platform.padEnd(8)} approve=${d.permissions.approveRequests} 最近在线=${d.lastSeenAt ?? '-'}${d.revokedAt ? '（已吊销）' : ''}`,
      );
    }
  });

  remote.command('revoke <id>').description('吊销设备（立即失效）').action((id: string) => {
    if (deviceRevoke(id)) console.log(`已吊销 ${id}`);
    else {
      console.error(`设备不存在：${id}`);
      process.exitCode = 1;
    }
  });

  remote.command('rename <id> <name>').description('重命名设备').action((id: string, name: string) => {
    if (deviceRename(id, name)) console.log(`已重命名 ${id} → ${name}`);
    else {
      console.error(`设备不存在：${id}`);
      process.exitCode = 1;
    }
  });
}