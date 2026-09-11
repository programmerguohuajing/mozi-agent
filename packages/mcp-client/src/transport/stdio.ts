/**
 * stdio 传输（M8 §8.3.2）：本地子进程 server。
 * 协议边界：按 MCP stdio 规范，每行一个 JSON-RPC 消息（换行分隔）。
 * stderr 重定向到日志回调，不进协议流。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  Disposable,
  JsonRpcMessage,
  McpTransport,
  StdioServerConfig,
  TransportKind,
} from './types.js';

const DEFAULT_TIMEOUT = 5000;

export class StdioTransport implements McpTransport {
  readonly kind: TransportKind = 'stdio';
  private child?: ChildProcess;
  private msgHandlers = new Set<(msg: JsonRpcMessage) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private buf = '';
  private started = false;
  private closed = false;
  private readonly timeoutMs: number;
  private logLine?: (line: string) => void;

  constructor(
    private cfg: StdioServerConfig,
    opts: { logLine?: (line: string) => void } = {},
  ) {
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
    this.logLine = opts.logLine;
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): Disposable {
    this.msgHandlers.add(handler);
    return { dispose: () => this.msgHandlers.delete(handler) };
  }

  onClose(handler: (reason: string) => void): Disposable {
    this.closeHandlers.add(handler);
    return { dispose: () => this.closeHandlers.delete(handler) };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const isWin = process.platform === 'win32';
    // shell:false 时 Windows 无法直接执行 .cmd（如 npx），改为通过 shell 解析。
    const useShell = isWin && /\.cmd$|\.bat$/i.test(this.cfg.command);
    const child = spawn(this.cfg.command, this.cfg.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });
    this.child = child;

    child.on('error', (err) => this.fail(`spawn error: ${err.message}`));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (this.logLine) for (const l of chunk.split('\n')) if (l.trim()) this.logLine(l);
    });
    child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(`process exited code=${code} signal=${signal}`);
    });

    // 握手超时兜底：超时未 ready 视为启动失败。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio handshake timeout')), this.timeoutMs);
      child.on('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        for (const h of this.msgHandlers) h(msg);
      } catch {
        // 协议行解析失败：记录并忽略单行，不中断连接。
      }
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h(reason);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.child?.stdin) throw new Error('stdio transport not started');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    // 1s 后仍未退出则强杀。
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1000);
    await new Promise<void>((resolve) => {
      child.on('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      // 若已退出立即返回。
      if (child.exitCode !== null) {
        clearTimeout(killTimer);
        resolve();
      }
    });
    for (const h of this.closeHandlers) h('closed');
  }
}
