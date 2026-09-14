/**
 * MCP Server 添加表单 —— 设置中心「MCP Server 管理」与插件管理「MCP 服务」共用。
 *
 * 校验规则与主进程 `McpManager.add()` 完全一致（id 必填；stdio 必填 command；
 * http/sse 必填 url），避免「前端放行、后端拒绝」的不一致体验。
 */
import * as React from 'react';
import type { McpAddRequest } from '@mozi/protocol';
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
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (): Promise<void> => {
    setError('');
    const trimmedId = id.trim();
    if (!trimmedId) { setError(t('mcp.form.err.id')); return; }
    if (transport === 'stdio' && !command.trim()) { setError(t('mcp.form.err.command')); return; }
    if (transport !== 'stdio' && !url.trim()) { setError(`${transport} ${t('mcp.form.err.url')}`); return; }

    const req: McpAddRequest = { id: trimmedId, transport };
    if (transport === 'stdio') {
      req.command = command.trim();
      const argv = args.trim() ? args.trim().split(/\s+/) : [];
      if (argv.length > 0) req.args = argv;
    } else {
      req.url = url.trim();
    }

    setBusy(true);
    try {
      const res = await props.onSubmit(req);
      if (res.ok) {
        setId(''); setCommand(''); setArgs(''); setUrl('');
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
          {TRANSPORTS.map((tr) => <option key={tr} value={tr}>{tr}</option>)}
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
        <input
          className="input-field"
          placeholder={t('mcp.form.url.placeholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}

      <div className="input-row-group" style={{ justifyContent: 'flex-end' }}>
        {props.onCancel ? <button className="btn-sm" onClick={props.onCancel}>{t('mcp.form.cancel')}</button> : null}
        <button className="btn-sm primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('mcp.form.submitting') : t('mcp.form.submit')}
        </button>
      </div>

      {error ? <div className="test-result fail">{error}</div> : null}
    </div>
  );
}
