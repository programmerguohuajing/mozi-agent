import type { McpAddRequest } from '@mozi/protocol';
/**
 * MCP Server 添加表单 —— 设置中心「MCP Server 管理」与插件管理「MCP 服务」共用。
 *
 * 校验规则与主进程 `McpManager.add()` 完全一致（id 必填；stdio 必填 command；
 * http/sse 必填 url），避免「前端放行、后端拒绝」的不一致体验。
 */
import * as React from 'react';
import { useApp } from '../i18n.js';

export interface McpAddFormProps {
  /** 提交新增请求；返回后端结果。 */
  onSubmit: (req: McpAddRequest) => Promise<{ ok: boolean; error?: string }>;
  /** 取消 / 成功后收起表单。 */
  onCancel?: () => void;
}

const TRANSPORTS: Array<McpAddRequest['transport']> = ['stdio', 'http', 'sse'];

export function McpAddForm(props: McpAddFormProps): React.ReactElement {
  const { t } = useApp();
  const [id, setId] = React.useState('');
  const [transport, setTransport] = React.useState<McpAddRequest['transport']>('stdio');
  const [command, setCommand] = React.useState('');
  const [args, setArgs] = React.useState('');
  const [url, setUrl] = React.useState('');
  // http/sse 附加头（JSON 文本编辑；如 {"Authorization":"Bearer xxx"}）
  const [headersText, setHeadersText] = React.useState('');
  const [timeoutText, setTimeoutText] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (): Promise<void> => {
    setError('');
    const trimmedId = id.trim();
    if (!trimmedId) {
      setError(t('mcp.form.err.id'));
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      setError(t('mcp.form.err.command'));
      return;
    }
    if (transport !== 'stdio' && !url.trim()) {
      setError(`${transport} ${t('mcp.form.err.url')}`);
      return;
    }

    const req: McpAddRequest = { id: trimmedId, transport };
    if (transport === 'stdio') {
      req.command = command.trim();
      const argv = args.trim() ? args.trim().split(/\s+/) : [];
      if (argv.length > 0) req.args = argv;
    } else {
      req.url = url.trim();
      // 附加请求头：JSON 对象（如 {"Authorization": "Bearer xxx"}）
      if (headersText.trim()) {
        try {
          const headers = JSON.parse(headersText) as Record<string, string>;
          if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
            setError('Headers 必须是 JSON 对象，如 {"Authorization": "Bearer xxx"}');
            return;
          }
          req.headers = headers;
        } catch (e) {
          setError(`Headers JSON 语法错误：${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
    }
    if (timeoutText.trim()) {
      const ms = Number(timeoutText.trim());
      if (!Number.isFinite(ms) || ms <= 0) {
        setError('超时必须是正整数（毫秒）');
        return;
      }
      req.timeoutMs = Math.floor(ms);
    }

    setBusy(true);
    try {
      const res = await props.onSubmit(req);
      if (res.ok) {
        setId('');
        setCommand('');
        setArgs('');
        setUrl('');
        setHeadersText('');
        setTimeoutText('');
        props.onCancel?.();
      } else {
        setError(res.error ?? t('mcp.form.err.generic'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 10,
        padding: 12,
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-1)',
      }}
    >
      <div className="input-row-group">
        <input
          className="input-field"
          style={{ flex: 1 }}
          placeholder={t('mcp.form.id.placeholder')}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <select
          className="select-field"
          style={{ minWidth: 110 }}
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpAddRequest['transport'])}
        >
          {TRANSPORTS.map((tr) => (
            <option key={tr} value={tr}>
              {tr}
            </option>
          ))}
        </select>
      </div>

      {transport === 'stdio' ? (
        <div className="input-row-group">
          <input
            className="input-field"
            style={{ flex: 1 }}
            placeholder={t('mcp.form.command.placeholder')}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="input-field"
            style={{ flex: 1 }}
            placeholder={t('mcp.form.args.placeholder')}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>
      ) : (
        <>
          <input
            className="input-field"
            placeholder={t('mcp.form.url.placeholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {/* 附加请求头（Authorization 等）：JSON 文本，直传 transport 层 headers */}
          <textarea
            className="input-field"
            style={{
              minHeight: 60,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              resize: 'vertical',
              whiteSpace: 'pre',
            }}
            spellCheck={false}
            placeholder='Headers（JSON，可选）如 {"Authorization": "Bearer sk-xxx"}'
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
          />
        </>
      )}

      <div className="input-row-group">
        <input
          className="input-field"
          style={{ maxWidth: 220 }}
          type="number"
          placeholder="超时 ms（默认 30000）"
          value={timeoutText}
          onChange={(e) => setTimeoutText(e.target.value)}
        />
      </div>

      <div className="input-row-group" style={{ justifyContent: 'flex-end' }}>
        {props.onCancel ? (
          <button className="btn-sm" onClick={props.onCancel}>
            {t('mcp.form.cancel')}
          </button>
        ) : null}
        <button className="btn-sm primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('mcp.form.submitting') : t('mcp.form.submit')}
        </button>
      </div>

      {error ? <div className="test-result fail">{error}</div> : null}
    </div>
  );
}
