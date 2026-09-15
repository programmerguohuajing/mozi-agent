/**
 * M17 screenshot 服务（§17.3）：agent 主动获取视觉输入。
 *
 * 平台命令（按桌面环境探测）：
 *   mac   : screencapture
 *   win   : PowerShell System.Drawing Graphics.CopyFromScreen
 *   linux : grim | import（按可用性选择）
 * browser : playwright-core（按需动态安装，不进默认依赖）
 *
 * 截图后统一走 VisionPipeline 落盘 + OCR，输出 contentId（事件只带 id）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type OcrProvider, VisionPipeline } from './pipeline.js';

export interface ScreenshotServiceOptions {
  mediaDir: string;
  /** 截图命令执行器（测试注入；默认真实 execFile）。 */
  runCommand?: (cmd: string, args: string[], timeoutMs: number) => Promise<Buffer>;
  /** 浏览器截图实现（playwright-core；未注入时 browser 模式报错）。 */
  browserCapture?: (input: {
    url: string;
    waitMs?: number;
    fullPage?: boolean;
  }) => Promise<Buffer>;
  /** OCR provider（可选）。 */
  ocr?: OcrProvider;
  /** 平台覆盖（测试注入）。 */
  platform?: NodeJS.Platform;
  /** 缩放实现透传。 */
  scaler?: ConstructorParameters<typeof VisionPipeline>[0]['scaler'];
  idGen?: () => string;
  /** 命令超时（默认 15s）。 */
  timeoutMs?: number;
}

export interface ScreenshotResult {
  path: string;
  contentId: string;
  ocrText?: string;
  estimatedTokens?: number;
  browser?: boolean;
}

export class ScreenshotService {
  private readonly pipeline: VisionPipeline;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly opts: ScreenshotServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.pipeline = new VisionPipeline({
      mediaDir: opts.mediaDir,
      ...(opts.ocr ? { ocr: opts.ocr } : {}),
      ...(opts.scaler ? { scaler: opts.scaler } : {}),
      ...(opts.idGen ? { idGen: opts.idGen } : {}),
    });
  }

  async screenshot(input: {
    target?:
      | { kind: 'screen' }
      | { kind: 'window'; title: string }
      | { kind: 'browser'; url: string; waitMs?: number; fullPage?: boolean };
    annotate?: { highlight?: string };
  }): Promise<ScreenshotResult> {
    const target = input.target ?? { kind: 'screen' as const };
    if (target.kind === 'browser') {
      if (!this.opts.browserCapture) {
        throw new Error(
          '浏览器截图需要 playwright-core（未安装）。请安装 playwright-core 后重试，或改用 target.kind="screen"。',
        );
      }
      const buf = await this.opts.browserCapture({
        url: target.url,
        ...(typeof target.waitMs === 'number' ? { waitMs: target.waitMs } : {}),
        ...(target.fullPage ? { fullPage: target.fullPage } : {}),
      });
      return this.finalize(buf, true);
    }
    const buf = await this.captureNative(target);
    return this.finalize(buf, false);
  }

  private async finalize(buf: Buffer, browser: boolean): Promise<ScreenshotResult> {
    // 截图统一按 png 处理；若平台产出其它格式，管线会按 magic bytes 识别
    const img = await this.pipeline.process(buf, { visionCapable: false });
    return {
      path: img.path,
      contentId: img.contentId,
      ...(img.ocrText ? { ocrText: img.ocrText } : {}),
      estimatedTokens: img.estimatedTokens,
      ...(browser ? { browser: true } : {}),
    };
  }

  private async captureNative(target: {
    kind: 'screen' | 'window';
    title?: string;
  }): Promise<Buffer> {
    const timeout = this.opts.timeoutMs ?? 15_000;
    const tmpFile = path.join(
      os.tmpdir(),
      `mozi-shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`,
    );
    try {
      if (this.platform === 'darwin') {
        const args = ['-x']; // 静音
        if (target.kind === 'window' && target.title) args.push('-l', target.title);
        args.push(tmpFile);
        await this.run('screencapture', args, timeout);
      } else if (this.platform === 'win32') {
        // 脚本从环境变量 MOZI_SHOT_OUT 读取输出路径（避免脚本内转义路径的问题）
        const script = WINDOWS_CAPTURE_SCRIPT;
        await this.run(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script, tmpFile],
          timeout,
          { MOZI_SHOT_OUT: tmpFile },
        );
      } else {
        // linux：优先 grim（Wayland），回退 import（X11）
        try {
          await this.run('grim', [tmpFile], timeout);
        } catch {
          await this.run('import', ['-window', 'root', tmpFile], timeout);
        }
      }
      return fs.readFileSync(tmpFile);
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  private run(
    cmd: string,
    args: string[],
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<string> {
    if (this.opts.runCommand) {
      return this.opts.runCommand(cmd, args, timeoutMs).then((b) => b.toString('utf8'));
    }
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          env: env ? { ...process.env, ...env } : process.env,
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
  }
}

/** Windows 全屏截图（System.Drawing），输出路径经 MOZI_SHOT_OUT 环境变量传入。 */
const WINDOWS_CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
  '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
  '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
  '$g = [System.Drawing.Graphics]::FromImage($bmp);',
  '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);',
  '$bmp.Save($env:MOZI_SHOT_OUT, [System.Drawing.Imaging.ImageFormat]::Png);',
].join(' ');
