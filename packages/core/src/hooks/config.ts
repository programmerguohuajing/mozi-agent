/**
 * M18 Hooks 配置加载与防投毒（§18.3/§18.5）。
 *
 * 配置文件：
 *   ~/.mozi/hooks.json            用户级：直接生效（用户自己写的 = 用户权限）
 *   <workspace>/.mozi/hooks.json  项目级：默认禁用；首次发现需逐条审查 + 一次性确认；
 *                                  启用记录指纹；文件变更需重新确认；
 *                                  headless/CI 一律忽略（不可交互确认的环境不执行未确认代码）
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookSpec,
  type HooksFile,
  type ProjectHookApproval,
  type ResolvedHook,
} from './types.js';

export const USER_HOOKS_PATH = path.join(os.homedir(), '.mozi', 'hooks.json');

export function projectHooksPath(workspace: string): string {
  return path.join(workspace, '.mozi', 'hooks.json');
}

/** 项目级 hooks 的审批记录文件（放在项目内，随项目走；不含敏感内容）。 */
export function projectApprovalPath(workspace: string): string {
  return path.join(workspace, '.mozi', 'hooks.approved.json');
}

/** 文件内容指纹（§18.5：变更 → 重新确认）。 */
export function fingerprintFile(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/** 校验单条 hook 定义（非法条目跳过并记录原因，不静默接受）。 */
function validateSpec(raw: unknown, where: string): { spec?: HookSpec; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: `${where}: hook 必须是对象` };
  const h = raw as Partial<HookSpec>;
  if (!h.event || !HOOK_EVENTS.includes(h.event as HookEvent)) {
    return { error: `${where}: 未知事件 "${String(h.event)}"` };
  }
  if (typeof h.run !== 'string' || !h.run.trim()) {
    return { error: `${where}: run 必须是非空字符串` };
  }
  if (h.onExit !== undefined && typeof h.onExit !== 'object') {
    return { error: `${where}: onExit 必须是对象` };
  }
  return { spec: h as HookSpec };
}

export interface LoadResult {
  hooks: ResolvedHook[];
  /** 被跳过/忽略的条目说明（诊断用，也供 UI 展示）。 */
  warnings: string[];
  /** 项目级 hooks 是否需要用户确认（首次或指纹变更）。 */
  needsApproval: {
    /** 待审查的命令全文（UI 显示）。 */
    commands: string[];
    file: string;
    fingerprint: string;
    /** 'first-time' | 'changed' */
    reason: 'first-time' | 'changed';
  } | null;
}

export interface LoadHooksOptions {
  workspace: string;
  userHooksPath?: string;
  /** headless/CI：忽略项目级 hooks（§18.5 防线 4）。 */
  headless?: boolean;
}

/**
 * 加载生效的 hooks。
 * - 用户级：总是加载。
 * - 项目级：仅当 headless=false 且已用当前指纹确认过时才加载；
 *   否则通过 needsApproval 告知调用方（不执行）。
 */
export function loadHooks(opts: LoadHooksOptions): LoadResult {
  const warnings: string[] = [];
  const hooks: ResolvedHook[] = [];

  // ---- 用户级 ----
  const userPath = opts.userHooksPath ?? USER_HOOKS_PATH;
  const userFile = readHooksFile(userPath, warnings);
  if (userFile) {
    userFile.hooks.forEach((raw, index) => {
      const { spec, error } = validateSpec(raw, `${userPath}#${index}`);
      if (error) warnings.push(error);
      else if (spec) hooks.push({ ...spec, origin: 'user', source: userPath, index });
    });
  }

  // ---- 项目级（防投毒）----
  let needsApproval: LoadResult['needsApproval'] = null;
  const projPath = projectHooksPath(opts.workspace);
  const fp = fingerprintFile(projPath);
  if (fp) {
    const projFile = readHooksFile(projPath, warnings);
    if (projFile && projFile.hooks.length) {
      const commands = projFile.hooks.map((h) => String((h as HookSpec).run ?? ''));
      if (opts.headless) {
        warnings.push(
          `忽略项目级 hooks（headless/CI 不执行未确认代码）：${projPath} 共 ${commands.length} 条`,
        );
      } else {
        const approval = readApproval(opts.workspace);
        if (!approval || approval.fingerprint !== fp) {
          // 未确认 或 文件已变更 → 请求确认，且不执行
          needsApproval = {
            commands,
            file: projPath,
            fingerprint: fp,
            reason: approval ? 'changed' : 'first-time',
          };
        } else {
          projFile.hooks.forEach((raw, index) => {
            const { spec, error } = validateSpec(raw, `${projPath}#${index}`);
            if (error) warnings.push(error);
            else if (spec) hooks.push({ ...spec, origin: 'project', source: projPath, index });
          });
        }
      }
    }
  }

  return { hooks, warnings, needsApproval };
}

/**
 * 用户确认启用项目级 hooks（§18.5 防线 1/2）：写入一次性确认 + 指纹。
 * @param commands 用户审查过的命令全文（留痕）
 */
export function approveProjectHooks(
  workspace: string,
  fingerprint: string,
  commands: string[],
  approvedAt = new Date().toISOString(),
): void {
  const p = projectApprovalPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ fingerprint, approvedAt, commands } satisfies ProjectHookApproval, null, 2));
}

export function readApproval(workspace: string): ProjectHookApproval | undefined {
  try {
    return JSON.parse(fs.readFileSync(projectApprovalPath(workspace), 'utf8')) as ProjectHookApproval;
  } catch {
    return undefined;
  }
}

function readHooksFile(file: string, warnings: string[]): HooksFile | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HooksFile>;
    if (!Array.isArray(parsed.hooks)) {
      warnings.push(`${file}: 缺少 hooks 数组`);
      return undefined;
    }
    return { hooks: parsed.hooks as HookSpec[] };
  } catch (e) {
    warnings.push(`${file}: 解析失败 (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}
