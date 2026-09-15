import type {
  AuditQueryRequest,
  ChannelServer,
  ConfigGetResponse,
  McpAddRequest,
  McpGetConfigResponse,
  McpServerInfo,
  McpSetConfigRequest,
  McpSetConfigResponse,
  PartialApplyRequest,
  ProviderAddRequest,
  ProviderDiscoverRequest,
  ProviderDiscoverResponse,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderRemoveRequest,
  ProviderSummary,
  ProviderTestRequest,
  ProviderTestResponse,
  ProviderUpdateRequest,
  RunStartRequest,
  ScheduleCreateRequest,
  ScheduleCreateResponse,
  SendChannelMap,
  SessionState,
  SkillSummary,
  WorkspaceListEntriesRequest,
  WorkspaceListEntriesResponse,
  WorkspacePickResponse,
} from '@mozi/protocol';
import { approvalTicketFromEvent } from '@mozi/protocol';
/**
 * IpcBridge：把 §10.3 的 channel 清单落到 AgentService 上（M10 §10.2 / §10.3）。
 *
 * 传输无关 —— 通过 `ChannelServer` 注入。Electron 主进程传 `webContents` 适配器，
 * 测试 / TUI 传 `LoopbackChannel`。两种传输共用同一 handler 注册表，
 * 保证「移动端协议 = 桌面 IPC 协议」零分叉（§14 原则 3）。
 *
 * 安全约束（§10.6）：密钥只在主进程；`config:listProviders` 只回脱敏摘要。
 */
import type { AgentEvent, PolicyMode } from '@mozi/shared';
import type { AgentService } from './agent-service.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { BrowserService } from './browser-service.js';
import type { DiffReviewService } from './diff-service.js';
import type { McpManager } from './mcp-manager.js';
import type { SettingsStore } from './settings-store.js';
import { listSkills } from './skill-scanner.js';
import type { TaskSchedulerHost } from './tasks-host.js';

export interface IpcBridgeDeps {
  service: AgentService;
  settings: SettingsStore;
  diff: DiffReviewService;
  mcp: McpManager;
  /** 内置浏览器服务（截图标注）。 */
  browser?: BrowserService;
  /** 会话级浏览器注册表：渲染端 BrowserPanel 的 webview 接管（agent 同页面操作）。 */
  browserRegistry?: BrowserRegistry;
  /** 定时任务宿主（M4.5 / M13）：SchedulePanel 真实数据源。 */
  tasks?: TaskSchedulerHost;
  /**
   * 屏幕截图能力（renderer 输入栏"截图"按钮）：
   * 截取整屏并返回 PNG base64 + 真实像素尺寸。由主进程用 electron.desktopCapturer 注入。
   */
  captureScreen?: ScreenCapturer;
  /**
   * 原生目录选择器（新建任务时选本地文件夹作为 workspace）：
   * 返回选中的目录绝对路径；用户取消时返回 null。由主进程用 electron.dialog 注入。
   */
  pickWorkspace?: () => Promise<string | null>;
  /** 传输：注册 handler + 推送 send。 */
  channel: ChannelServer;
  /** 当前接收方标识（窗口 id / 连接 id），用于多窗口聚焦判定。 */
  recipientId?: string;
  /** provider 设置变更后的回调（主进程重建 ProviderRegistry 用）。 */
  onProvidersChanged?: () => void;
}

/** 屏幕截图结果：`base64` 为不带 data: 前缀的 PNG；`width/height` 为真实像素尺寸（标注坐标依赖）。 */
export interface ScreenCaptureResult {
  base64: string;
  width: number;
  height: number;
}

/** 屏幕截图器（主进程注入；不可用时抛错，由 handler 转为 `{ error }`）。 */
export type ScreenCapturer = () => Promise<ScreenCaptureResult>;

export class IpcBridge {
  private readonly sessionWindow = new Map<string, string>();

  constructor(private readonly deps: IpcBridgeDeps) {}

  /** provider 配置变更后通知主进程（重建 ProviderRegistry）。 */
  private providersChanged(): void {
    try {
      this.deps.onProvidersChanged?.();
    } catch {
      /* best-effort */
    }
  }

  /**
   * provider 配置写盘的守卫包装。
   *
   * settings-store 的 setProvider/setApiKey 是同步 fs 写盘（含密钥加密），失败时抛错。
   * 若异常直接冒泡：invoke 的 Promise 会 reject 到渲染进程 → 调用方（SettingsPanel 的
   * handleAddProvider）的 `await` 中断，`setShowAddForm(false)` 不执行，表单既不关闭也不
   * 报错，界面卡在「表单可见但已提交」的半死状态（用户主观感受即「点完之后就不对劲了」）。
   * 这里统一转成 `{ ok:false, error }`，让上层能正常回显错误并复位表单。
   */
  private guardedWrite<T extends { ok: boolean; error?: string }>(
    fn: () => T,
    fallbackError: string,
  ): T {
    try {
      return fn();
    } catch (err) {
      return {
        ok: false,
        error: `${fallbackError}：${err instanceof Error ? err.message : String(err)}`,
      } as T;
    }
  }

  /** 注册全部 invoke handler。 */
  install(): void {
    const {
      channel,
      service,
      settings,
      diff,
      mcp,
      browser,
      browserRegistry,
      captureScreen,
      pickWorkspace,
      tasks,
    } = this.deps;

    channel.handle('session:create', async (req) => {
      const summary = await service.create(req);
      this.emitStatus(summary.id, summary.state);
      return summary;
    });

    channel.handle('session:resume', async (req) => {
      const summary = await service.resume(req.sessionId);
      if (summary) {
        this.emitStatus(req.sessionId, summary.state);
        // 历史事件回放：渲染端重建消息 / 上下文占用 / 子智能体树。
        service.replayEvents(req.sessionId);
      }
      return summary;
    });

    channel.handle('session:fork', async (req) => {
      const summary = await service.fork(req.sessionId, req.atEventIndex);
      // 分叉后自动载入池。
      await service.resume(summary.id);
      return summary;
    });

    channel.handle('session:list', () => service.list());

    channel.handle('session:delete', (req) => service.delete(req.sessionId));

    // ── 更换会话项目文件夹（输入栏「+」→ 选择项目文件夹）──────────
    channel.handle('session:setWorkspace', async (req) => {
      const res = await service.setWorkspace(req.sessionId, req.workspaceRoot);
      if (res.ok && res.summary) this.emitStatus(req.sessionId, res.summary.state);
      return res;
    });

    channel.handle('run:start', (req: RunStartRequest) => {
      // 注入当前设置的策略模式（§10.5 权限模式即时生效）：
      // 会话的 policy 在创建时固化，若不随每轮覆盖，UI 改成"完全访问"
      // 后已有会话仍沿用旧模式（auto/readonly）继续弹审批。
      const overrides = {
        ...(req.overrides ?? {}),
        policy: req.overrides?.policy ?? {
          mode: settings.policyMode(),
          rules: settings.policyRules(),
        },
      };
      const res = service.start({ ...req, overrides });
      if (res.accepted) {
        // 回放该会话已积累的待审批（UI 重连补齐）。
        for (const ticket of service.pendingApprovals(req.sessionId)) {
          this.send('engine:event', {
            sessionId: ticket.sessionId,
            event: {
              type: 'tool.approval.required',
              call: ticket.call,
              reason: ticket.reason,
              ts: new Date().toISOString(),
            },
          });
        }
      }
      return res;
    });

    channel.handle('approval:resolve', (req) => {
      const ok = service.resolveApproval(req).ok;
      if (ok && req.onceForSession) settings.appendAllowRule(req.sessionId, req.callId);
      return { ok };
    });

    channel.handle('engine:abort', (req) => service.abort(req));

    channel.handle('config:get', (): ConfigGetResponse => {
      const all = settings.getAll();
      return {
        settings: all,
        providers: settings.listProviders(),
        policyMode: settings.policyMode(),
      };
    });

    channel.handle('config:set', (req) => {
      // 处理 API Key 保存：渲染进程传 patch.pendingKey = { id, secret }
      const patch = req.patch as Record<string, unknown>;
      if (patch.pendingKey && typeof patch.pendingKey === 'object') {
        const { id, secret } = patch.pendingKey as { id: string; secret: string };
        const result = settings.setApiKey(id, secret);
        if (!result.ok) return { ok: false };
        // pendingKey 已处理，不透传到 applyPatch
        const { pendingKey: _unused, ...rest } = patch;
        void _unused;
        if (Object.keys(rest).length > 0) settings.applyPatch(rest);
        return { ok: true };
      }
      settings.applyPatch(patch);
      // 权限模式切换：同步 AgentService 默认值（后续新建引擎的兜底 policy）。
      if (typeof patch.policyMode === 'string') {
        service.setPolicyMode(patch.policyMode as PolicyMode);
      }
      return { ok: true };
    });

    channel.handle('config:listProviders', (): ProviderSummary[] => settings.listProviders());

    /**
     * 拉取 provider 端点下的全部模型（§10.5④ 模型下拉）。
     * 密钥只在主进程使用：优先请求中的临时 apiKey（表单未保存），否则取已存密钥。
     * 本地无鉴权端点（FreeLLMAPI / Ollama 等）无需 key 也可拉取。
     *
     * 防御性解析（修复 "Unexpected token '<'" 报错）：
     *   - "API + Dashboard 同端口"的网关（FreeLLMAPI 等）对未知路径常返回
     *     200 的 SPA HTML 页面 —— 必须先判 HTML 再解析，否则 res.json() 抛
     *     "Unexpected token '<', "<!DOCTYPE"..."；
     *   - openai 格式：Base URL 不带 /v1 段时自动回退尝试 {base}/v1/models；
     *     responses / anthropic 格式：Base URL 已带 /v1 段时回退 {base}/models；
     *   - gemini listModels 响应为 { models: [{ name: "models/xxx" }] }。
     */
    channel.handle(
      'provider:models',
      async (req: ProviderModelsRequest): Promise<ProviderModelsResponse> => {
        const all = settings.getAll() as {
          providers: Record<
            string,
            {
              model: string;
              baseUrl?: string;
              apiFormat?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
            }
          >;
        };
        const spec = all.providers[req.providerId];
        const baseUrl = (req.baseUrl?.trim() || spec?.baseUrl)?.replace(/\/+$/, '');
        if (!baseUrl) return { ok: false, error: '未配置 Base URL，无法获取模型列表' };
        const apiFormat = req.apiFormat ?? spec?.apiFormat ?? 'openai';
        const apiKey = req.apiKey ?? settings.getApiKey(req.providerId);
        const headers: Record<string, string> = { accept: 'application/json' };
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;

        // 各格式的候选路径（顺序尝试）：
        //   openai             {base}/models（base 无版本段时追加 {base}/v1/models）
        //   openai-responses / anthropic   {base}/v1/models（base 已含 /v1 段时追加 {base}/models）
        //   gemini             {base}/v1beta/models
        const hasVersionSeg = /\/v\d+[a-z]*$/i.test(baseUrl);
        const candidates: string[] = [];
        if (apiFormat === 'openai') {
          candidates.push(`${baseUrl}/models`);
          if (!hasVersionSeg) candidates.push(`${baseUrl}/v1/models`);
        } else if (apiFormat === 'openai-responses' || apiFormat === 'anthropic') {
          candidates.push(`${baseUrl}/v1/models`);
          if (hasVersionSeg) candidates.push(`${baseUrl}/models`);
        } else {
          candidates.push(`${baseUrl}/v1beta/models`);
        }

        let lastError = '';
        for (const url of candidates) {
          try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
            const text = await res.text().catch(() => '');
            if (res.ok) {
              if (/^\s*(<!DOCTYPE|<html)/i.test(text)) {
                // 命中网页（Dashboard / SPA fallback）而非 API：试下一个候选路径。
                lastError =
                  '该地址返回的是网页（HTML）而非 API。请检查 Base URL 是否正确（如 OpenAI 格式需含 /v1 版本段）';
                continue;
              }
              let body: {
                data?: Array<{ id?: string; name?: string }>;
                models?: Array<{ name?: string }>;
              };
              try {
                body = JSON.parse(text) as typeof body;
              } catch {
                lastError = `端点 ${url} 返回了非 JSON 内容（前 100 字符：${text.slice(0, 100)}）`;
                continue;
              }
              // OpenAI 系：data[].id；Gemini：models[].name（去掉 "models/" 前缀）。
              const raw =
                apiFormat === 'gemini'
                  ? (body.models ?? []).map((m) => m.name?.replace(/^models\//, ''))
                  : (body.data ?? []).map((m) => m.id ?? m.name);
              const models = [...new Set(raw.filter((x): x is string => Boolean(x)))].sort();
              return { ok: true, models };
            }
            if (res.status === 404 || res.status === 405) {
              // 路径不存在：试下一个候选（可能是版本段拼接问题）。
              lastError = `HTTP ${res.status}（路径 ${url} 不存在）`;
              continue;
            }
            const authHint =
              res.status === 401 || res.status === 403 ? '（API Key 无效或权限不足）' : '';
            return { ok: false, error: `HTTP ${res.status}${authHint} ${text.slice(0, 200)}` };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          ok: false,
          error: `${lastError}。已尝试：${candidates.join(' , ')}`,
        };
      },
    );

    /** 常用本地端口（FreeLLMAPI / LM Studio / Ollama 等默认端口）。 */
    const DEFAULT_LOCAL_PORTS = [3000, 4000, 5000, 8000, 8080, 8884, 9999];

    /**
     * 探测本地 OpenAI 兼容服务（FreeLLMAPI 等，§10.5④ 一键连接）。
     * 依次请求 `http://127.0.0.1:<port>/v1/models`（无鉴权），
     * 第一个返回 2xx 且能解析出模型列表的端口即视为可用端点。
     * 注意：FreeLLMAPI 等网关的 Dashboard 与 API 同端口，未知路径会返回
     * 200 的 HTML 页面 —— 必须校验内容为 JSON 且含 data 数组，避免误判。
     */
    channel.handle(
      'provider:discoverLocal',
      async (req: ProviderDiscoverRequest): Promise<ProviderDiscoverResponse> => {
        const ports = req.ports && req.ports.length > 0 ? req.ports : DEFAULT_LOCAL_PORTS;
        for (const port of ports) {
          const base = `http://127.0.0.1:${port}`;
          try {
            const res = await fetch(`${base}/v1/models`, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(1500),
            });
            if (!res.ok) continue;
            const text = await res.text().catch(() => '');
            // HTML（Dashboard / SPA fallback）不算模型服务。
            if (/^\s*(<!DOCTYPE|<html)/i.test(text)) continue;
            let body: { data?: unknown };
            try {
              body = JSON.parse(text) as typeof body;
            } catch {
              continue;
            }
            if (!Array.isArray(body.data)) continue;
            return { ok: true, baseUrl: `${base}/v1`, port };
          } catch {
            // 端口未监听 / 超时：继续下一个
          }
        }
        return {
          ok: false,
          error: `未在本地发现可用的模型服务（已探测端口：${ports.join(', ')}）`,
        };
      },
    );

    channel.handle(
      'config:testProvider',
      async (req: ProviderTestRequest): Promise<ProviderTestResponse> => {
        // 注入真实 ping 实现：按 provider 的上游格式发一条最小请求验证连通性。
        const pingImpl = async (providerId: string, apiKey: string | undefined): Promise<void> => {
          const all = settings.getAll() as {
            providers: Record<
              string,
              {
                model: string;
                baseUrl?: string;
                apiFormat?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
              }
            >;
          };
          const spec = all.providers[providerId];
          if (!spec) throw new Error(`provider ${providerId} 不存在`);
          const format = spec.apiFormat ?? 'openai';
          const base = (spec.baseUrl ?? '').replace(/\/+$/, '');
          let url: string;
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          let body: Record<string, unknown>;
          if (format === 'openai') {
            const baseUrl = base || 'https://api.openai.com/v1';
            url = `${baseUrl}/chat/completions`;
            if (apiKey) headers.authorization = `Bearer ${apiKey}`;
            // model 为空（自动路由）：不带 model 字段。
            body = {
              ...(spec.model ? { model: spec.model } : {}),
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            };
          } else if (format === 'openai-responses') {
            const baseUrl = base || 'https://api.openai.com';
            url = `${baseUrl}/v1/responses`;
            if (apiKey) headers.authorization = `Bearer ${apiKey}`;
            body = {
              ...(spec.model ? { model: spec.model } : {}),
              input: 'ping',
              max_output_tokens: 1,
              stream: false,
            };
          } else if (format === 'anthropic') {
            const baseUrl = base || 'https://api.anthropic.com';
            url = `${baseUrl}/v1/messages`;
            if (apiKey) headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            body = {
              ...(spec.model ? { model: spec.model } : {}),
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            };
          } else {
            const baseUrl = base || 'https://generativelanguage.googleapis.com';
            const modelSeg = spec.model ? `models/${spec.model}:` : '';
            url = `${baseUrl}/v1beta/${modelSeg}generateContent${apiKey ? `?key=${apiKey}` : ''}`;
            body = { contents: [{ parts: [{ text: 'ping' }] }] };
          }
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
          }
        };
        return settings.testProvider(req.providerId, pingImpl);
      },
    );

    channel.handle('provider:add', (req: ProviderAddRequest) => {
      const id = req.id.trim();
      if (!id) return { ok: false, error: 'Provider ID 不能为空' };
      // 模型名可空（网关自动路由）；models / modelMap 提供多模型接入。
      const hasMap = Boolean(req.modelMap && Object.keys(req.modelMap).length > 0);
      const hasModels = Boolean(req.models && req.models.length > 0);
      if (!req.model.trim() && !hasMap && !hasModels) {
        // 允许：自动路由（model 空）—— 但必须显式确认 baseUrl 存在
        if (!req.baseUrl?.trim()) return { ok: false, error: '自动路由模式必须填写 Base URL' };
      }
      const written = this.guardedWrite<{ ok: boolean; error?: string }>(() => {
        settings.setProvider(id, {
          model: req.model,
          models: hasModels ? req.models : undefined,
          baseUrl: req.baseUrl,
          apiKeyEnv: req.apiKeyEnv,
          apiFormat: req.apiFormat,
          modelMap: req.modelMap,
        });
        if (req.apiKey) {
          const result = settings.setApiKey(id, req.apiKey);
          if (!result.ok) return { ok: false, error: result.error };
        }
        return { ok: true };
      }, '写入 provider 配置失败');
      if (!written.ok) return written;
      this.providersChanged();
      return { ok: true };
    });

    channel.handle('provider:remove', (req: ProviderRemoveRequest) => {
      const removed = this.guardedWrite<{ ok: boolean; error?: string }>(
        () => {
          settings.removeProvider(req.id);
          return { ok: true };
        },
        '删除 provider 失败',
      );
      if (!removed.ok) return removed;
      this.providersChanged();
      return { ok: true };
    });

    channel.handle('provider:update', (req: ProviderUpdateRequest) => {
      const id = req.id.trim();
      if (!id) return { ok: false, error: 'Provider ID 不能为空' };
      // 读取现有配置，合并更新
      const all = settings.getAll() as {
        providers: Record<
          string,
          {
            model: string;
            models?: string[];
            baseUrl?: string;
            apiKeyEnv?: string;
            apiFormat?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
            modelMap?: Record<string, string>;
          }
        >;
      };
      const existing = all.providers[id];
      if (!existing) return { ok: false, error: `Provider ${id} 不存在` };
      // model 允许更新为空（切换到自动路由）；req.model 为 undefined 时保持原值。
      const nextModel = req.model === undefined ? existing.model : req.model.trim();
      const nextMap = req.modelMap !== undefined ? req.modelMap : existing.modelMap;
      const nextModels =
        req.models !== undefined
          ? req.models.length > 0
            ? req.models
            : undefined
          : existing.models;
      // 自动路由（model 空 + 无映射 + 无模型列表）必须有 baseUrl。
      if (
        !nextModel &&
        !(nextMap && Object.keys(nextMap).length > 0) &&
        !(nextModels && nextModels.length > 0) &&
        !existing.baseUrl &&
        !req.baseUrl?.trim()
      ) {
        return { ok: false, error: '自动路由模式必须填写 Base URL' };
      }
      const written = this.guardedWrite<{ ok: boolean; error?: string }>(() => {
        settings.setProvider(id, {
          model: nextModel,
          models: nextModels,
          baseUrl: req.baseUrl !== undefined ? req.baseUrl.trim() || undefined : existing.baseUrl,
          apiKeyEnv:
            req.apiKeyEnv !== undefined ? req.apiKeyEnv.trim() || undefined : existing.apiKeyEnv,
          apiFormat: req.apiFormat ?? existing.apiFormat,
          modelMap: nextMap,
        });
        if (req.apiKey) {
          const result = settings.setApiKey(id, req.apiKey);
          if (!result.ok) return { ok: false, error: result.error };
        }
        return { ok: true };
      }, '写入 provider 配置失败');
      if (!written.ok) return written;
      this.providersChanged();
      return { ok: true };
    });

    channel.handle('mcp:list', (): McpServerInfo[] => mcp.list());

    channel.handle('mcp:add', async (req: McpAddRequest) => {
      return mcp.add(req);
    });

    channel.handle('mcp:remove', async (req) => mcp.remove(req.id));

    channel.handle('mcp:restart', async (req) => mcp.restart(req.id));

    // ── mcp.json 直接编辑（§10.5⑦）：读取完整配置 / 校验并整体替换 ──
    channel.handle(
      'mcp:getConfig',
      (): McpGetConfigResponse => ({ ok: true, servers: mcp.config() }),
    );

    channel.handle(
      'mcp:setConfig',
      async (req: McpSetConfigRequest): Promise<McpSetConfigResponse> => {
        if (!Array.isArray(req.servers)) {
          return { ok: false, error: 'servers 必须是数组' };
        }
        return mcp.replaceAll(req.servers);
      },
    );

    channel.handle('audit:query', (req: AuditQueryRequest) => service.audit(req));

    channel.handle('dashboard:stats', () => service.dashboard());

    channel.handle('diff:applyPartial', (req: PartialApplyRequest) => diff.applyPartial(req));

    // ── 输入栏"截图"：截取整屏 → 标注 → 作为附件 ──────────────
    channel.handle('browser:capture', async () => {
      // 首选：主进程桌面屏幕捕获（desktopCapturer），返回真实像素尺寸供标注定位。
      if (captureScreen) {
        try {
          const shot = await captureScreen();
          return {
            contentId: `screen-${Date.now()}`,
            base64: shot.base64,
            width: shot.width,
            height: shot.height,
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }
      // 退化：内置浏览器页面截图（未注入屏幕捕获时）。
      if (!browser) {
        return { error: '截图不可用：主进程未注入屏幕捕获能力（electron.desktopCapturer）' };
      }
      try {
        const result = await browser.screenshot();
        return { contentId: result.contentId, base64: result.base64, width: 0, height: 0 };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });

    channel.handle('browser:saveAnnotated', (req: { base64: string; sessionId?: string }) => {
      const contentId = `annotated-${Date.now()}`;
      return { ok: true, contentId };
    });

    // ── 任务浏览器面板：渲染端 webview 接管 / 解除 ────────────────
    // BrowserPanel 打开 → dom-ready 后上报 guest webContentsId，
    // 主进程按会话接管；agent 的 browser 工具与用户看到同一页面。
    channel.handle('browser:attach', (req: { sessionId: string; webContentsId: number }) => {
      if (!browserRegistry) {
        return { ok: false, error: '浏览器注册表不可用（主进程未注入 electron.webContents）' };
      }
      return browserRegistry.attach(req.sessionId, req.webContentsId);
    });

    channel.handle('browser:detach', (req: { sessionId: string }) => {
      browserRegistry?.detach(req.sessionId);
      return { ok: true };
    });

    // ── 任务 workspace：原生目录选择框（§10.5① 新建任务）──────────
    channel.handle('workspace:pick', async (): Promise<WorkspacePickResponse> => {
      if (!pickWorkspace) {
        return { ok: false, error: '目录选择器不可用（主进程未注入 electron.dialog）' };
      }
      try {
        const dir = await pickWorkspace();
        // null = 用户取消：ok 但无路径，渲染进程据此不创建会话。
        return dir ? { ok: true, path: dir } : { ok: true, canceled: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });

    // ── @ 引用：列出 / 搜索 workspace 内文件与文件夹（输入框弹层）───
    channel.handle(
      'workspace:listEntries',
      (req: WorkspaceListEntriesRequest): WorkspaceListEntriesResponse => service.listEntries(req),
    );

    // ── 技能列表：内置 + ~/.mozi/skills + <workspace>/.mozi/skills ──
    channel.handle('skills:list', (req: { sessionId?: string }): SkillSummary[] => {
      const ws = req.sessionId ? service.workspaceOf(req.sessionId) : undefined;
      return listSkills(ws);
    });

    // ── 定时任务（M4.5 / M13）：SchedulePanel 真实数据源 ──────────
    channel.handle('schedule:list', () => tasks?.list() ?? []);

    channel.handle('schedule:create', (req: ScheduleCreateRequest): ScheduleCreateResponse => {
      if (!tasks) return { ok: false, error: '定时任务宿主不可用' };
      return tasks.create(req);
    });

    channel.handle('schedule:toggle', (req: { id: string }) =>
      tasks ? tasks.toggle(req.id) : { ok: false, error: '定时任务宿主不可用' },
    );

    channel.handle('schedule:delete', (req: { id: string }) =>
      tasks ? tasks.remove(req.id) : { ok: false, error: '定时任务宿主不可用' },
    );

    channel.handle('schedule:runNow', async (req: { id: string }) =>
      tasks ? tasks.runNow(req.id) : { ok: false, error: '定时任务宿主不可用' },
    );
  }

  /**
   * 事件扇出：引擎事件 → 对应会话的接收方（§10.2）。
   * 供 AgentService 的 `emit` 回调直接调用。
   */
  onEngineEvent = (event: AgentEvent): void => {
    const sessionId = resolveSessionId(event);
    this.send('engine:event', { sessionId, event });
    const ticket = approvalTicketFromEvent(sessionId, event);
    if (ticket) {
      this.send('session:status', { sessionId, state: 'pending_approval' });
    }
  };

  /** 会话状态推送（§10.3 session:status）。 */
  onSessionStatus = (sessionId: string, state: SessionState): void => {
    this.emitStatus(sessionId, state);
  };

  /**
   * 定时任务状态变化推送（TaskSchedulerHost.onTaskEvent）：
   * 渲染端 SchedulePanel 收到后重取 schedule:list（tick 到期 / 启停 / 删除 / 运行完成）。
   */
  notifyScheduleChanged = (): void => {
    this.send('schedule:changed', {});
  };

  private emitStatus(sessionId: string, state: SessionState): void {
    this.send('session:status', { sessionId, state });
  }

  private send<C extends keyof SendChannelMap>(channel: C, payload: SendChannelMap[C]): void {
    try {
      this.deps.channel.send(channel, payload);
    } catch {
      /* 接收方已销毁：静默丢弃（窗口关闭 ≠ 会话销毁） */
    }
  }

  /** 注册窗口占用（多窗口聚焦，§10.4）。 */
  attachWindow(sessionId: string): { alreadyOpen: boolean; focus: string | null } {
    const windowId = this.deps.recipientId ?? 'default';
    const res = this.deps.service.attachWindow(sessionId, windowId);
    if (!res.alreadyOpen) this.sessionWindow.set(sessionId, windowId);
    return res;
  }

  detachWindow(sessionId: string): void {
    const windowId = this.deps.recipientId ?? 'default';
    this.deps.service.detachWindow(sessionId, windowId);
    this.sessionWindow.delete(sessionId);
  }
}

/** 从任意事件解析归属会话 id（子智能体事件归父会话，便于 UI 分桶）。 */
function resolveSessionId(event: AgentEvent): string {
  const anyEv = event as unknown as Record<string, unknown>;
  if (typeof anyEv.sessionId === 'string') return anyEv.sessionId;
  if (typeof anyEv.parentSessionId === 'string') return anyEv.parentSessionId;
  return '*';
}
