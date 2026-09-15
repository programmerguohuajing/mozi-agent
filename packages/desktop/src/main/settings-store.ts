/**
 * SettingsStore + CredentialStore（M10 §10.6）。
 *
 * - 设置：JSON 持久化（electron-store 语义，但零依赖 → 可在 Node 直接测试）；
 * - 密钥：`SafeStorageLike` 抽象（Electron `safeStorage`）；加密后存
 *   `settings.credentials.<provider>.encrypted`。safeStorage 不可用时（Linux headless）
 *   拒绝明文存储并提示改用环境变量；
 * - **密钥绝不进渲染进程**：`listProviders()` 只回 `hasApiKey` + 脱敏预览。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApiFormat, ProviderSummary, ProviderTestResponse } from '@mozi/protocol';
import type { PolicyMode, PolicyRule } from '@mozi/shared';

/** Electron `safeStorage` 的最小契约（便于注入 mock 与纯 Node 运行）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 密钥打码：只保留前缀与末 4 位（§10.6）。 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '…';
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

interface CredentialRecord {
  encrypted?: string; // base64
  plain?: string; // 仅在用户显式允许不安全存储时（默认禁用）
  envVar?: string; // 改用环境变量的提示
}

/** 关闭应用窗口时的行为（基础设置 §10.7）。 */
export type CloseBehavior = 'quit' | 'tray';

/**
 * 策略规则清洗：丢弃 `once-` 前缀的历史会话级规则（现已迁入内存管理），
 * 并对 match+action 完全相同的重复规则去重（保留首条，UI 不再显示成排重复项）。
 */
export function dedupePolicyRules(rules: PolicyRule[]): PolicyRule[] {
  const seen = new Set<string>();
  const out: PolicyRule[] = [];
  for (const r of rules) {
    if (r.id.startsWith('once-')) continue;
    const key = `${JSON.stringify(r.match)}|${r.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

interface SettingsShape {
  policyMode: PolicyMode;
  policyRules: PolicyRule[];
  providers: Record<
    string,
    {
      model: string;
      /** 该提供商接入的模型列表（多模型，本地名=上游名直传）。 */
      models?: string[];
      baseUrl?: string;
      apiKeyEnv?: string;
      apiFormat?: ApiFormat;
      modelMap?: Record<string, string>;
    }
  >;
  credentials: Record<string, CredentialRecord>;
  sandboxLevel: 0 | 1 | 2 | 3;
  costLimits: { perSessionUsd?: number; perDayUsd?: number };
  mcpServers: Array<Record<string, unknown>>;
  backgroundRun: boolean;
  /** 关闭主窗口时的行为：直接退出，或最小化到系统托盘常驻。 */
  closeBehavior: CloseBehavior;
  [key: string]: unknown;
}

const DEFAULTS: SettingsShape = {
  policyMode: 'auto',
  policyRules: [],
  providers: {},
  credentials: {},
  sandboxLevel: 1,
  costLimits: {},
  mcpServers: [],
  backgroundRun: true,
  // 与 backgroundRun 默认一致：关闭窗口后常驻后台（通过系统托盘可视化）。
  closeBehavior: 'tray',
};

export interface SettingsStoreOptions {
  /** 设置文件路径（默认 ~/.mozi/desktop/settings.json）。 */
  filePath: string;
  /** OS 级加密（Electron safeStorage）；不传则视为不可用。 */
  safeStorage?: SafeStorageLike;
  /** 允许在 safeStorage 不可用时明文存储（默认 false，§10.6）。 */
  allowInsecure?: boolean;
}

export class SettingsStore {
  private data: SettingsShape;
  private readonly filePath: string;
  /**
   * 会话级临时 allow 规则（「本会话一律允许」）：**只存内存、不持久化** ——
   * 生命周期 = 应用进程存活期（重启天然失效，符合"本会话"语义）。
   * 每会话一个稳定数组实例，追加规则时原地 push。
   */
  private readonly sessionAllows = new Map<string, PolicyRule[]>();

  constructor(private readonly opts: SettingsStoreOptions) {
    this.filePath = opts.filePath;
    this.data = this.load();
    this.migratePolicyRules();
  }

  /**
   * 历史数据迁移（一次性）：早期版本把「本会话一律允许」规则持久化进
   * policyRules（id 以 `once-` 开头、match 恒为 {"tool":"*"}），每审批一次
   * 追加一条、永不清理 —— 策略规则面板因此堆满重复项。会话级临时规则现已
   * 改为内存管理（appendSessionAllow），此处把存量垃圾清掉，并对剩余完全
   * 重复的规则（match+action 相同）去重。
   */
  private migratePolicyRules(): void {
    const before = this.data.policyRules;
    const cleaned = dedupePolicyRules(before);
    if (cleaned.length !== before.length) {
      this.data.policyRules = cleaned;
      this.persist();
    }
  }

  private load(): SettingsShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* best-effort */
    }
  }

  getAll(): Record<string, unknown> {
    return structuredClone(this.data) as unknown as Record<string, unknown>;
  }

  policyMode(): PolicyMode {
    return this.data.policyMode;
  }

  policyRules(): PolicyRule[] {
    return this.data.policyRules;
  }

  sandboxLevel(): 0 | 1 | 2 | 3 {
    return this.data.sandboxLevel;
  }

  backgroundRun(): boolean {
    return this.data.backgroundRun;
  }

  /** 关闭主窗口时的行为（§10.7 基础设置）。 */
  closeBehavior(): CloseBehavior {
    return this.data.closeBehavior;
  }

  /** 更新关闭行为：'quit' 直接退出；'tray' 最小化到托盘常驻。 */
  setCloseBehavior(behavior: CloseBehavior): void {
    this.data.closeBehavior = behavior;
    this.persist();
  }

  /** 合并式更新（config:set）。未知键直接透传存储（前向兼容）。 */
  applyPatch(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch } as SettingsShape;
    this.persist();
  }

  setPolicyMode(mode: PolicyMode): void {
    this.data.policyMode = mode;
    this.persist();
  }

  /** 策略规则增删（§10.5④ 策略规则编辑器）。 */
  setPolicyRules(rules: PolicyRule[]): void {
    this.data.policyRules = rules;
    this.persist();
  }

  /**
   * 「本会话一律允许」：为该会话追加一条针对**该工具**的 allow 规则。
   * - 会话隔离：只影响此会话（run:start 时合并进该会话的 policy.rules）；
   * - 同会话同工具只保留一条（去重，不再堆积重复项）；
   * - match 用具体工具名而非 `'*'` —— 引擎的 ruleMatches 对 tool 是字面匹配，
   *   旧实现的 `{"tool":"*"}` 是永不命中的死规则。
   */
  appendSessionAllow(sessionId: string, tool: string): void {
    let rules = this.sessionAllows.get(sessionId);
    if (!rules) {
      rules = [];
      this.sessionAllows.set(sessionId, rules);
    }
    const id = `once-${sessionId}:${tool}`;
    if (rules.some((r) => r.id === id)) return;
    rules.push({ id, match: { tool }, action: 'allow' });
  }

  /** 该会话的临时 allow 规则（run:start 注入用；其他会话不可见）。 */
  sessionAllowRules(sessionId: string): PolicyRule[] {
    return this.sessionAllows.get(sessionId) ?? [];
  }

  /** 该会话是否已放行某工具（审批流自动放行判断用）。 */
  isSessionAllowed(sessionId: string, tool: string): boolean {
    const id = `once-${sessionId}:${tool}`;
    return this.sessionAllows.get(sessionId)?.some((r) => r.id === id) ?? false;
  }

  /** 会话删除时清理其临时规则。 */
  clearSessionAllows(sessionId: string): void {
    this.sessionAllows.delete(sessionId);
  }

  // ── 密钥（§10.6）────────────────────────────────────────────────

  /** 存储 API Key（OS 级加密）。safeStorage 不可用且未允许不安全 → 抛出。 */
  setApiKey(providerId: string, secret: string): { ok: boolean; error?: string } {
    const ss = this.opts.safeStorage;
    const available = ss?.isEncryptionAvailable() ?? false;
    if (!available) {
      if (!this.opts.allowInsecure) {
        return {
          ok: false,
          error:
            'OS 级加密不可用（safeStorage）。已拒绝明文存储，请改用环境变量（如 MOZI_API_KEY）。',
        };
      }
      this.data.credentials[providerId] = { plain: secret };
      this.persist();
      return { ok: true };
    }
    const encrypted = ss?.encryptString(secret).toString('base64');
    this.data.credentials[providerId] = { encrypted };
    this.persist();
    return { ok: true };
  }

  /**
   * 取回密钥明文（**仅主进程内部调用**；绝不回传渲染进程）。
   * 优先加密记录，其次环境变量回退（§10.6）。
   *
   * 若记录为密文但 safeStorage 当前不可用（换机器 / 密钥环被重置 / headless），
   * **绝不**把密文当明文返回 —— 那会让上游把 ciphertext 当 API Key 发出去。
   * 此时视为「读不到」，直接回退环境变量。
   */
  getApiKey(providerId: string): string | undefined {
    const rec = this.data.credentials[providerId];
    if (rec?.encrypted) {
      const ss = this.opts.safeStorage;
      if (ss?.isEncryptionAvailable()) {
        try {
          return ss.decryptString(Buffer.from(rec.encrypted, 'base64'));
        } catch {
          /* 解密失败（换机器/密钥环重置）→ 回退环境变量 */
        }
      }
      // safeStorage 不可用：无法解密，不返回密文。
    }
    if (rec?.plain) return rec.plain;
    const envName =
      this.data.providers[providerId]?.apiKeyEnv ?? `${providerId.toUpperCase()}_API_KEY`;
    return (
      process.env[envName] ?? (providerId === 'default' ? process.env.MOZI_API_KEY : undefined)
    );
  }

  /** 设置 provider（模型 / 模型列表 / baseUrl / 密钥环境变量名 / 上游格式 / 模型映射）。 */
  setProvider(
    id: string,
    spec: {
      model: string;
      models?: string[];
      baseUrl?: string;
      apiKeyEnv?: string;
      apiFormat?: ApiFormat;
      modelMap?: Record<string, string>;
    },
  ): void {
    this.data.providers[id] = spec;
    this.persist();
  }

  /** 删除 provider 配置及其密钥记录。 */
  removeProvider(id: string): void {
    delete this.data.providers[id];
    delete this.data.credentials[id];
    this.persist();
  }

  /** 脱敏的 provider 列表（渲染进程可见，§10.6）。 */
  listProviders(): ProviderSummary[] {
    return Object.entries(this.data.providers).map(([id, spec]) => {
      const rec = this.data.credentials[id];
      const fromEnv = this.getApiKey(id);
      const has = Boolean(rec?.encrypted || rec?.plain || fromEnv);
      const preview = fromEnv ? maskSecret(fromEnv) : undefined;
      const modelMap = spec.modelMap ?? {};
      const hasMap = Object.keys(modelMap).length > 0;
      const models = spec.models ?? [];
      const hasModels = models.length > 0;
      // 可选模型（任务窗口模型选择器数据源）：models 列表 > 映射本地名 > [model]。
      const selectable = hasModels
        ? models
        : hasMap
          ? Object.keys(modelMap)
          : spec.model
            ? [spec.model]
            : [id];
      // 自动路由：无 models、无映射、且 model 为空（网关自行选模型）。
      const autoRoute = !hasModels && !hasMap && !spec.model;
      return {
        id,
        model: spec.model,
        baseUrl: spec.baseUrl,
        apiFormat: spec.apiFormat ?? 'openai',
        models: selectable,
        // 映射原文（旧数据兼容；仅模型名，无敏感信息）。
        ...(hasMap ? { modelMap } : {}),
        ...(autoRoute ? { autoRoute: true } : {}),
        hasApiKey: has,
        maskedKey: preview,
      };
    });
  }

  setSandboxLevel(level: 0 | 1 | 2 | 3): void {
    this.data.sandboxLevel = level;
    this.persist();
  }

  setBackgroundRun(enabled: boolean): void {
    this.data.backgroundRun = enabled;
    this.persist();
  }

  /**
   * 测试连接（§10.5④）：对 provider 发 1 条 ping 提示词。
   * 真实网络调用由注入的 `ping` 完成（协议/引擎层），此处只做编排与计时。
   * 本地无鉴权端点（FreeLLMAPI 等）无需 API Key 也可连通。
   */
  async testProvider(
    providerId: string,
    ping?: (id: string, apiKey: string | undefined) => Promise<void>,
  ): Promise<ProviderTestResponse> {
    if (!ping) return { ok: false, error: '未注入 ping 实现（需真实 provider）' };
    const key = this.getApiKey(providerId);
    const started = Date.now();
    try {
      await ping(providerId, key);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 成本上限（§10.5④）。 */
  costLimits(): { perSessionUsd?: number; perDayUsd?: number } {
    return this.data.costLimits;
  }
}
