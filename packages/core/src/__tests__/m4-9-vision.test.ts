import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ImageDimensions,
  MAX_IMAGE_BYTES,
  ScreenshotService,
  UnsupportedImageError,
  VisionPipeline,
  VisionUnavailableError,
  estimateImageTokens,
  imagePlaceholder,
  readDimensions,
  sniffFormat,
  validateVerifyStep,
} from '@mozi/core';
import { screenshotTool } from '@mozi/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M17 多模态测试（§17.5）：
 * 图片管线（格式/大小/缩放/OCR 降级/能力协商）、screenshot 三平台桩 + browser 模式、
 * Token 计费、压缩占位、VerifyStep 校验。
 */

let tmp: string;
let mediaDir: string;
let seq = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m17-'));
  mediaDir = path.join(tmp, 'media');
  seq = 0;
});

afterEach(() => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      /* EBUSY retry */
    }
  }
});

/** 构造最小合法 PNG（指定宽高）。 */
function makePng(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type RGBA
  // 结尾加 IEND 让 readDimensions 之外的逻辑也安全
  return Buffer.concat([sig, ihdr, Buffer.from('IEND')]);
}

/** 构造最小 JPEG（含 SOF0 段，指定宽高）。 */
function makeJpeg(w: number, h: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2); // 段长
  sof[4] = 8; // 精度
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  sof[10] = 1;
  return Buffer.concat([soi, sof, Buffer.from([0xff, 0xd9])]);
}

/** 构造最小 WEBP（VP8X 头，指定宽高）。 */
function makeWebp(w: number, h: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // 24 位宽高（减一存储）
  buf[24] = (w - 1) & 0xff;
  buf[25] = ((w - 1) >> 8) & 0xff;
  buf[26] = ((w - 1) >> 16) & 0xff;
  buf[27] = (h - 1) & 0xff;
  buf[28] = ((h - 1) >> 8) & 0xff;
  buf[29] = ((h - 1) >> 16) & 0xff;
  return buf;
}

describe('M17 图像头部解析（零依赖）', () => {
  it('sniffFormat 按 magic bytes 识别，扩展名无关', () => {
    expect(sniffFormat(makePng(4, 4))).toBe('png');
    expect(sniffFormat(makeJpeg(4, 4))).toBe('jpeg');
    expect(sniffFormat(makeWebp(4, 4))).toBe('webp');
    expect(sniffFormat(Buffer.from('not an image'))).toBeUndefined();
  });

  it('readDimensions 三种格式', () => {
    expect(readDimensions(makePng(100, 50), 'png')).toEqual({
      width: 100,
      height: 50,
      format: 'png',
    });
    expect(readDimensions(makeJpeg(320, 240), 'jpeg')).toEqual({
      width: 320,
      height: 240,
      format: 'jpeg',
    });
    expect(readDimensions(makeWebp(800, 600), 'webp')).toEqual({
      width: 800,
      height: 600,
      format: 'webp',
    });
  });

  it('estimateImageTokens 使用 OpenAI 公式 (w×h)/750', () => {
    expect(estimateImageTokens({ width: 750, height: 1, format: 'png' })).toBe(1);
    expect(estimateImageTokens({ width: 1000, height: 1500, format: 'png' })).toBe(2000);
  });
});

describe('M17 图片管线', () => {
  const newPipeline = (over: Partial<ConstructorParameters<typeof VisionPipeline>[0]> = {}) =>
    new VisionPipeline({ mediaDir, idGen: () => `img-${++seq}`, ...over });

  it('支持 vision：注入 mode=image + dataUrl，落盘 .mozi/media，事件只带 contentId', async () => {
    const p = newPipeline();
    const img = await p.process(makePng(64, 32), { visionCapable: true });
    expect(img.mode).toBe('image');
    expect(img.contentId).toBe('img-1');
    expect(img.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(fs.existsSync(img.path)).toBe(true);
    expect(img.estimatedTokens).toBe(3);
    const uc = p.toUserContent(img, '按钮错位');
    expect(uc).toMatchObject({ type: 'image', alt: '按钮错位' });
  });

  it('格式不支持 → 明确报错', async () => {
    const p = newPipeline();
    await expect(p.process(Buffer.from('GIF89a...'), { visionCapable: true })).rejects.toThrow(
      UnsupportedImageError,
    );
  });

  it('大小超 5MB → 拒绝', async () => {
    const p = newPipeline();
    const big = Buffer.concat([makePng(4, 4), Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expect(p.process(big, { visionCapable: true })).rejects.toThrow(/超出上限 5MB/);
  });

  it('长边 >2048 且注入 scaler → 触发缩放', async () => {
    let called = false;
    const p = newPipeline({
      scaler: async (buf, dims, maxEdge) => {
        called = true;
        const scale = maxEdge / Math.max(dims.width, dims.height);
        const nd: ImageDimensions = {
          width: Math.round(dims.width * scale),
          height: Math.round(dims.height * scale),
          format: dims.format,
        };
        return { buf, dims: nd, scaled: true };
      },
    });
    const img = await p.process(makePng(4096, 1024), { visionCapable: true });
    expect(called).toBe(true);
    expect(img.scaled).toBe(true);
    expect(Math.max(img.dimensions.width, img.dimensions.height)).toBe(2048);
  });

  it('长边 ≤2048 → 不缩放', async () => {
    const p = newPipeline();
    const img = await p.process(makePng(1024, 768), { visionCapable: true });
    expect(img.scaled).toBe(false);
  });

  it('不支持 vision + OCR 高置信 → 降级为文本占位', async () => {
    const p = newPipeline({
      ocr: { recognize: async () => ({ text: '错误：无法解析模块 foo', confidence: 0.92 }) },
    });
    const img = await p.process(makePng(100, 100), { visionCapable: false });
    expect(img.mode).toBe('ocr');
    expect(img.ocrText).toContain('无法解析模块');
    const uc = p.toUserContent(img);
    expect(uc.type).toBe('text');
    expect((uc as { text: string }).text).toContain('[图片：img-1，OCR 摘要');
  });

  it('不支持 vision + OCR 置信度低 + 任务依赖视觉 → 建议换模型（不硬猜）', async () => {
    const p = newPipeline({
      ocr: { recognize: async () => ({ text: '乱码', confidence: 0.2 }) },
    });
    await expect(
      p.process(makePng(100, 100), { visionCapable: false, requiresVision: true }),
    ).rejects.toThrow(VisionUnavailableError);
  });

  it('不支持 vision + 无 OCR + 不依赖视觉 → 占位不报错', async () => {
    const p = newPipeline();
    const img = await p.process(makePng(100, 100), { visionCapable: false });
    expect(img.mode).toBe('ocr');
    expect(img.ocrText).toBe('');
    const uc = p.toUserContent(img);
    expect((uc as { text: string }).text).toContain('未能提取文本');
  });

  it('imagePlaceholder：压缩区图片占位截前 100 字（§17.2）', () => {
    expect(imagePlaceholder('img-9', 'x'.repeat(200))).toBe(
      `[图片：img-9，OCR 摘要：${'x'.repeat(100)}]`,
    );
    expect(imagePlaceholder('img-9')).toBe('[图片：img-9]');
  });
});

describe('M17 screenshot 工具与服务', () => {
  const ctxOf = (vision?: unknown) =>
    ({
      workspace: {} as never,
      signal: new AbortController().signal,
      sessionId: 's1',
      ...(vision ? { vision } : {}),
    }) as never;

  it('未注入 vision → 工具返回明确错误', async () => {
    const r = await screenshotTool.execute({ target: { kind: 'screen' } }, ctxOf());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not available');
  });

  it('参数校验：window 缺 title / browser 缺 url', async () => {
    const svc = { screenshot: async () => ({ path: 'p', contentId: 'c' }) };
    const r1 = await screenshotTool.execute({ target: { kind: 'window', title: '' } }, ctxOf(svc));
    expect(r1.isError).toBe(true);
    const r2 = await screenshotTool.execute({ target: { kind: 'browser', url: '' } }, ctxOf(svc));
    expect(r2.isError).toBe(true);
  });

  it('成功路径：渲染图片卡片 display + OCR 摘要', async () => {
    const svc = {
      screenshot: async () => ({
        path: '/tmp/a.png',
        contentId: 'img-7',
        ocrText: '登录表单居中',
        estimatedTokens: 1200,
      }),
    };
    const r = await screenshotTool.execute({ target: { kind: 'screen' } }, ctxOf(svc));
    expect(r.isError).toBe(false);
    expect(r.display).toMatchObject({ kind: 'image', path: '/tmp/a.png', contentId: 'img-7' });
    expect(r.content).toContain('登录表单居中');
    expect(r.content).toContain('tokens≈1200');
  });

  it('ScreenshotService：win32 平台命令桩产出 PNG → 管线落盘', async () => {
    const cmds: string[] = [];
    const svc = new ScreenshotService({
      mediaDir,
      platform: 'win32',
      idGen: () => `img-${++seq}`,
      runCommand: async (cmd, args) => {
        cmds.push(cmd);
        // win32：输出路径为最后一个参数；真实命令经 MOZI_SHOT_OUT 环境变量获得
        const out = args[args.length - 1];
        if (out?.endsWith('.png')) fs.writeFileSync(out, makePng(200, 100));
        return Buffer.from('');
      },
    });
    const r = await svc.screenshot({ target: { kind: 'screen' } });
    expect(cmds[0]).toBe('powershell');
    expect(r.contentId).toBe('img-1');
    expect(fs.existsSync(r.path)).toBe(true);
  });

  it('ScreenshotService：darwin 走 screencapture', async () => {
    const cmds: string[] = [];
    const svc = new ScreenshotService({
      mediaDir,
      platform: 'darwin',
      runCommand: async (cmd, args) => {
        cmds.push(cmd);
        const out = args[args.length - 1];
        if (out?.endsWith('.png')) fs.writeFileSync(out, makePng(80, 60));
        return Buffer.from('');
      },
    });
    await svc.screenshot({ target: { kind: 'screen' } });
    expect(cmds[0]).toBe('screencapture');
  });

  it('ScreenshotService：linux 优先 grim', async () => {
    const cmds: string[] = [];
    const svc = new ScreenshotService({
      mediaDir,
      platform: 'linux',
      runCommand: async (cmd, args) => {
        cmds.push(cmd);
        const out = args[args.length - 1];
        if (out?.endsWith('.png')) fs.writeFileSync(out, makePng(80, 60));
        return Buffer.from('');
      },
    });
    await svc.screenshot({ target: { kind: 'screen' } });
    expect(cmds[0]).toBe('grim');
  });

  it('ScreenshotService：browser 模式（注入 playwright 桩）→ 标 browser=true', async () => {
    const svc = new ScreenshotService({
      mediaDir,
      browserCapture: async ({ url, waitMs }) => {
        expect(url).toBe('http://localhost:3000');
        expect(waitMs).toBe(500);
        return makePng(1280, 720);
      },
    });
    const r = await svc.screenshot({
      target: { kind: 'browser', url: 'http://localhost:3000', waitMs: 500 },
    });
    expect(r.browser).toBe(true);
    expect(r.estimatedTokens).toBe(Math.ceil((1280 * 720) / 750));
  });

  it('ScreenshotService：browser 模式未装 playwright → 明确提示', async () => {
    const svc = new ScreenshotService({ mediaDir });
    await expect(svc.screenshot({ target: { kind: 'browser', url: 'http://x' } })).rejects.toThrow(
      /playwright-core/,
    );
  });
});

describe('M17 VerifyStep 校验（§17.4）', () => {
  it('无步骤 → ok', () => {
    expect(validateVerifyStep(undefined, false)).toEqual({ ok: true });
  });

  it('executor 非 vision-capable → 创建时拒绝', () => {
    const r = validateVerifyStep(
      { kind: 'screenshot', url: 'http://localhost:3000', expectation: '表单居中' },
      false,
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('vision-capable');
  });

  it('vision-capable → 通过；缺 url/expectation → 拒绝', () => {
    expect(
      validateVerifyStep(
        { kind: 'screenshot', url: 'http://localhost:3000', expectation: '表单居中' },
        true,
      ),
    ).toEqual({ ok: true });
    expect(validateVerifyStep({ kind: 'screenshot', url: '', expectation: 'x' }, true).ok).toBe(
      false,
    );
    expect(
      validateVerifyStep({ kind: 'screenshot', url: 'http://x', expectation: '' }, true).ok,
    ).toBe(false);
  });
});
