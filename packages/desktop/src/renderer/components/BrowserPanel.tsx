/**
 * 任务浏览器面板 — 会话视图右侧的内嵌浏览器（Electron `<webview>` 标签）。
 *
 * 职责：
 *   - URL 栏：输入网址回车导航；后退 / 前进 / 刷新
 *   - webview：独立 Chromium 进程加载页面（按会话隔离 partition，cookie/登录持久）
 *   - agent 桥接：webview 就绪后经 `browser:attach` 把 guest webContentsId 报给主进程，
 *     AgentService 注入的 BrowserService 即接管该页面 —— agent 的 browser 工具
 *     （navigate/click/fill/eval/screenshot）与用户看到的是同一页面；
 *   - 截图能力：宿主经 captureRef 取当前页面截图（base64 + 尺寸），
 *     供输入栏「截图」按钮（浏览器打开时才显示）走标注流程。
 *
 * webview 用命令式创建（document.createElement）：渲染进程 tsconfig 未含 Electron
 * 类型，JSX 无法识别 <webview> 元素；命令式创建同时便于在插入 DOM 前设置属性。
 */
import * as React from 'react';
import type { MoziApi } from '../App.js';
import { useApp } from '../i18n.js';

/** 截图结果（与输入栏 annotation 状态对齐；base64 不带 data: 前缀）。 */
export interface BrowserCapture {
  base64: string;
  width: number;
  height: number;
}

/** captureRef 的函数签名（BrowserPanel ready 时注入，卸载时置 null）。 */
export type BrowserCaptureFn = () => Promise<BrowserCapture | null>;

/** 结构化 ref（避免依赖 React.MutableRefObject —— 本仓 renderer tsconfig 下不可用）。 */
export interface BrowserCaptureRef {
  current: BrowserCaptureFn | null;
}

/** `<webview>` 标签的最小契约（渲染进程无 Electron 类型，手工声明用到的方法）。 */
interface WebviewElement extends HTMLElement {
  src: string;
  partition: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  getWebContentsId(): number;
  capturePage(): Promise<{
    toDataURL(): string;
    toPNG(): Buffer;
    getSize(): { width: number; height: number };
  }>;
}

export interface BrowserPanelProps {
  api: MoziApi;
  sessionId: string;
  /** 面板首次打开时加载的地址。 */
  initialUrl?: string;
  onClose: () => void;
  /** 宿主持有的截图函数 ref：面板就绪时注入，卸载时清空。 */
  captureRef: BrowserCaptureRef;
  /** 触发「标注」：截取当前页面并打开标注层（宿主维护 annotation 状态）。 */
  onCapture: () => void;
  /** 截图失败提示（由宿主 captureAndAnnotate 设置）。 */
  captureError?: string | null;
  /** 关闭截图失败提示。 */
  onDismissCaptureError?: () => void;
}

/** 补全 URL：无协议时默认 https://。 */
function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:') || s.startsWith('file://'))
    return s;
  return `https://${s}`;
}

const DEFAULT_URL = 'https://www.bing.com';

export function BrowserPanel(props: BrowserPanelProps): React.ReactElement {
  const { t } = useApp();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const [urlInput, setUrlInput] = React.useState(props.initialUrl ?? DEFAULT_URL);
  const [currentUrl, setCurrentUrl] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [canGoBack, setCanGoBack] = React.useState(false);
  const [canGoForward, setCanGoForward] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const syncNav = (wv: WebviewElement): void => {
    setCurrentUrl(wv.getURL());
    setTitle(wv.getTitle());
    setCanGoBack(wv.canGoBack());
    setCanGoForward(wv.canGoForward());
  };

  // webview 生命周期：创建 → 事件绑定 → attach 主进程 → 卸载 detach。
  // biome-ignore lint/correctness/useExhaustiveDependencies: webview 生命周期只随 sessionId 变化初始化一次，其余依赖为首次挂载时的稳定引用。
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wv = document.createElement('webview') as unknown as WebviewElement;
    wv.partition = `persist:mozi-${props.sessionId}`;
    wv.className = 'browser-webview';
    wv.src = props.initialUrl ?? DEFAULT_URL;
    host.appendChild(wv);
    webviewRef.current = wv;

    const onDomReady = (): void => {
      syncNav(wv);
      setLoading(false);
      // 上报 guest webContentsId：主进程接管后 agent 的 browser 工具操作同一页面。
      try {
        const webContentsId = wv.getWebContentsId();
        void props.api
          .invoke('browser:attach', { sessionId: props.sessionId, webContentsId })
          .then((r) => {
            const res = r as { ok: boolean; error?: string };
            if (!res.ok) setError(res.error ?? '浏览器桥接失败');
          })
          .catch(() => setError('浏览器桥接失败（无法连接主进程）'));
      } catch {
        setError('浏览器桥接失败（webContentsId 不可用）');
      }
    };
    const onDidNavigate = (e: Event): void => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (url) setCurrentUrl(url);
      syncNav(wv);
      setUrlInput(url ?? wv.getURL());
      setError(null);
    };
    const onPageTitle = (e: Event): void => {
      const t2 = (e as CustomEvent<{ title?: string }>).detail?.title;
      if (t2) setTitle(t2);
    };
    const onStartLoading = (): void => setLoading(true);
    const onStopLoading = (): void => {
      setLoading(false);
      syncNav(wv);
    };
    const onFailLoad = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          errorDescription?: string;
          validatedURL?: string;
          isMainFrame?: boolean;
        }>
      ).detail;
      if (detail?.isMainFrame === false) return;
      setLoading(false);
      setError(detail?.errorDescription || detail?.validatedURL || '页面加载失败');
    };

    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-navigate', onDidNavigate);
    wv.addEventListener('did-navigate-in-page', onDidNavigate);
    wv.addEventListener('page-title-updated', onPageTitle);
    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-fail-load', onFailLoad);

    // 截图能力注入：宿主输入栏「截图」按钮调用（浏览器打开时）。
    props.captureRef.current = async () => {
      const el = webviewRef.current;
      if (!el) return null;
      try {
        const img = await el.capturePage();
        const dataUrl = img.toDataURL();
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const size = img.getSize();
        return { base64, width: size.width, height: size.height };
      } catch {
        return null;
      }
    };

    return () => {
      void props.api.invoke('browser:detach', { sessionId: props.sessionId }).catch(() => {});
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-navigate', onDidNavigate);
      wv.removeEventListener('did-navigate-in-page', onDidNavigate);
      wv.removeEventListener('page-title-updated', onPageTitle);
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.remove();
      webviewRef.current = null;
      props.captureRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  const navigate = (raw: string): void => {
    const wv = webviewRef.current;
    const url = normalizeUrl(raw);
    if (!wv || !url) return;
    setError(null);
    setLoading(true);
    void wv.loadURL(url).catch((e: unknown) => {
      setLoading(false);
      setError(e instanceof Error ? e.message : '导航失败');
    });
  };

  const btn = (
    label: string,
    titleText: string,
    disabled: boolean,
    onClick: () => void,
  ): React.ReactElement => (
    <button
      type="button"
      className="browser-nav-btn"
      disabled={disabled}
      title={titleText}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        {btn('←', t('chat.browser.back'), !canGoBack, () => {
          webviewRef.current?.goBack();
        })}
        {btn('→', t('chat.browser.forward'), !canGoForward, () => {
          webviewRef.current?.goForward();
        })}
        {btn('↻', t('chat.browser.reload'), false, () => {
          webviewRef.current?.reload();
        })}
        <input
          className="browser-url-input"
          value={urlInput}
          placeholder={t('chat.browser.url.placeholder')}
          spellCheck={false}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              navigate(urlInput);
            }
          }}
        />
        {loading ? <span className="browser-loading" aria-hidden="true" /> : null}
        {/* 标注：截取当前页面 → 标注层（宿主管理 annotation 状态） */}
        <button
          type="button"
          className="browser-tool-btn"
          title={t('chat.browser.annotate')}
          aria-label={t('chat.browser.annotate')}
          onClick={() => props.onCapture()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2.6 6.4A1.6 1.6 0 0 1 4.2 4.9h1.3l0.9 -1.6h3.2l0.9 1.6h1.3a1.6 1.6 0 0 1 1.6 1.5v5.4a1.6 1.6 0 0 1 -1.6 1.6H4.2a1.6 1.6 0 0 1 -1.6 -1.6z" />
            <circle cx="8" cy="9.2" r="2.3" />
          </svg>
          {t('chat.browser.annotate')}
        </button>
        <button
          type="button"
          className="browser-close-btn"
          title={t('chat.browser.close')}
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>
      {title ? (
        <div className="browser-title" title={title}>
          {title}
        </div>
      ) : null}
      {error ? (
        <div className="browser-error" role="alert">
          {error}
        </div>
      ) : null}
      {props.captureError ? (
        <div className="browser-error" role="alert">
          <span className="browser-error-text">
            {t('chat.screenshot.failed')}：{props.captureError}
          </span>
          <button
            className="browser-error-close"
            onClick={() => props.onDismissCaptureError?.()}
            aria-label={t('chat.screenshot.dismiss')}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div className="browser-webview-host" ref={hostRef} />
    </div>
  );
}
