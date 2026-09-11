/**
 * M17 图片输入管线（§17.2）。
 *
 * 处理步骤：
 *   1. 校验：格式（png/jpeg/webp）+ 大小（≤5MB）
 *   2. 尺寸优化：长边 >2048px 等比缩放
 *   3. 能力协商（ProviderCapabilities.vision）：支持 → 注入 image content；
 *      不支持 → OCR 降级；置信度低且依赖视觉 → 明确告知用户换模型
 *   4. Token 计费：按 provider 公式估算（OpenAI: (w×h)/750）
 *   5. 存储：原图落盘 .mozi/media/<id>.png，事件只带 contentId
 *
 * 零原生依赖约束：不引入 sharp；尺寸读取走轻量头部解析，
 * 缩放委托给可注入的 ImageScaler（默认 pass-through 并标注未缩放）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { UserContent } from '@mozi/shared';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_LONG_EDGE = 2048; // px

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface ImageDimensions {
  width: number;
  height: number;
  format: ImageFormat;
}

export interface OcrProvider {
  /** 提取文本与置信度（0-1）。默认无 OCR → 返回 undefined。 */
  recognize(
    buf: Buffer,
  ): Promise<{ text: string; confidence: number } | undefined>;
}

/** 缩放器（可注入；默认不缩放并如实报告）。 */
export type ImageScaler = (
  buf: Buffer,
  dims: ImageDimensions,
  maxEdge: number,
) => Promise<{ buf: Buffer; dims: ImageDimensions; scaled: boolean }>;

export interface VisionPipelineOptions {
  /** 媒体落盘目录（默认 <workspace>/.mozi/media）。 */
  mediaDir: string;
  /** OCR 降级实现（可选）。 */
  ocr?: OcrProvider;
  /** 缩放实现（可选）。 */
  scaler?: ImageScaler;
  /** id 生成器（测试注入）。 */
  idGen?: () => string;
}

export interface ProcessedImage {
  contentId: string;
  /** 落盘路径。 */
  path: string;
  format: ImageFormat;
  dimensions: ImageDimensions;
  /** 原始字节数。 */
  bytes: number;
  /** 缩放后是否发生变化。 */
  scaled: boolean;
  /** 估算 token（计费，§17.2）。 */
  estimatedTokens: number;
  /** 归一化后的 dataUrl（供支持 vision 的 provider 注入）。 */
  dataUrl: string;
  /** 目的地：直接注入图片，或降级为 OCR 文本。 */
  mode: 'image' | 'ocr';
  /** OCR 文本（降级时）。 */
  ocrText?: string;
  /** OCR 置信度（降级时）。 */
  ocrConfidence?: number;
}

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

/** 能力协商结果：需要用户换模型。 */
export class VisionUnavailableError extends Error {
  constructor(
    message: string,
    /** 是否建议切换模型。 */
    readonly suggestModelSwitch: boolean,
  ) {
    super(message);
    this.name = 'VisionUnavailableError';
  }
}

/** 从 magic bytes 识别格式（不信任文件扩展名）。 */
export function sniffFormat(buf: Buffer): ImageFormat | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
}

/** 解析 PNG / JPEG / WEBP 尺寸（轻量头部解析，零依赖）。 */
export function readDimensions(buf: Buffer, format: ImageFormat): ImageDimensions {
  if (format === 'png') {
    // IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型
    if (buf.length < 24) throw new UnsupportedImageError('PNG 头部不完整');
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      format,
    };
  }
  if (format === 'jpeg') {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1] ?? 0;
      // SOF0..SOF15（跳过 DHT/DAC 等）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buf.readUInt16BE(off + 5),
          width: buf.readUInt16BE(off + 7),
          format,
        };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    throw new UnsupportedImageError('JPEG 未找到 SOF 尺寸段');
  }
  // webp：VP8X / VP8L / VP8 
  const fourCC = buf.toString('ascii', 12, 16);
  if (fourCC === 'VP8X') {
    const w = 1 + ((buf[24] ?? 0) | ((buf[25] ?? 0) << 8) | ((buf[26] ?? 0) << 16));
    const h = 1 + ((buf[27] ?? 0) | ((buf[28] ?? 0) << 8) | ((buf[29] ?? 0) << 16));
    return { width: w, height: h, format };
  }
  if (fourCC === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      format,
    };
  }
  if (fourCC === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return {
      width: (b & 0x3fff) + 1,
      height: ((b >> 14) & 0x3fff) + 1,
      format,
    };
  }
  throw new UnsupportedImageError('WEBP 尺寸解析失败');
}

/** OpenAI 图片 token 公式：(w×h)/750。 */
export function estimateImageTokens(dims: ImageDimensions): number {
  return Math.ceil((dims.width * dims.height) / 750);
}

export class VisionPipeline {
  private readonly mediaDir: string;
  private readonly ocr?: OcrProvider;
  private readonly scaler?: ImageScaler;
  private readonly idGen: () => string;

  constructor(opts: VisionPipelineOptions) {
    this.mediaDir = opts.mediaDir;
    this.ocr = opts.ocr;
    this.scaler = opts.scaler;
    this.idGen = opts.idGen ?? (() => `img-${Math.random().toString(36).slice(2, 10)}`);
  }

  /**
   * 处理一段图片字节。
   * @param visionCapable 执行模型是否支持视觉（ProviderCapabilities.vision）
   * @param opts.requiresVision 任务是否依赖视觉（决定降级时是否报错建议换模型）
   */
  async process(
    buf: Buffer,
    opts: { visionCapable: boolean; requiresVision?: boolean } = { visionCapable: false },
  ): Promise<ProcessedImage> {
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new UnsupportedImageError(
        `图片大小 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超出上限 5MB`,
      );
    }
    const format = sniffFormat(buf);
    if (!format) {
      throw new UnsupportedImageError('不支持的图片格式（仅 png/jpeg/webp）');
    }
    let dims = readDimensions(buf, format);
    let data = buf;
    let scaled = false;

    // 尺寸优化：长边 >2048 等比缩放
    const longEdge = Math.max(dims.width, dims.height);
    if (longEdge > MAX_LONG_EDGE && this.scaler) {
      const r = await this.scaler(buf, dims, MAX_LONG_EDGE);
      data = r.buf;
      dims = r.dims;
      scaled = r.scaled;
    }

    const contentId = this.idGen();
    const filePath = path.join(this.mediaDir, `${contentId}.${format === 'jpeg' ? 'jpg' : format}`);
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.writeFileSync(filePath, data);

    const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`;

    if (opts.visionCapable) {
      return {
        contentId,
        path: filePath,
        format,
        dimensions: dims,
        bytes: data.length,
        scaled,
        estimatedTokens: estimateImageTokens(dims),
        dataUrl,
        mode: 'image',
      };
    }

    // 降级链：vision 不支持 → OCR
    const recognized = this.ocr ? await this.ocr.recognize(data) : undefined;
    if (recognized && recognized.confidence >= 0.5) {
      return {
        contentId,
        path: filePath,
        format,
        dimensions: dims,
        bytes: data.length,
        scaled,
        estimatedTokens: estimateImageTokens(dims),
        dataUrl,
        mode: 'ocr',
        ocrText: recognized.text,
        ocrConfidence: recognized.confidence,
      };
    }
    // OCR 不可用或置信度低：若任务依赖视觉 → 明确告知换模型（不硬猜）
    if (opts.requiresVision) {
      throw new VisionUnavailableError(
        '当前模型不支持图片，请换 vision 模型（/model）；本任务依赖视觉信息，无法用 OCR 替代。',
        true,
      );
    }
    return {
      contentId,
      path: filePath,
      format,
      dimensions: dims,
      bytes: data.length,
      scaled,
      estimatedTokens: estimateImageTokens(dims),
      dataUrl,
      mode: 'ocr',
      ocrText: recognized?.text ?? '',
      ocrConfidence: recognized?.confidence ?? 0,
    };
  }

  /** 构造注入给 provider 的 UserContent（支持视觉时）。 */
  toUserContent(img: ProcessedImage, alt?: string): UserContent {
    if (img.mode === 'image') {
      return alt ? { type: 'image', dataUrl: img.dataUrl, alt } : { type: 'image', dataUrl: img.dataUrl };
    }
    return {
      type: 'text',
      text: `[图片：${img.contentId}${img.ocrText ? `，OCR 摘要：${img.ocrText.slice(0, 100)}` : '，未能提取文本'}]`,
    };
  }
}

/**
 * 压缩区占位（§17.2 末）：历史消息中的图片在进入 Auto-Compact 时，
 * 替换为「[图片：<id>，OCR 摘要：<前100字>]」以防持续烧 token。
 */
export function imagePlaceholder(contentId: string, ocrText?: string): string {
  const summary = (ocrText ?? '').slice(0, 100);
  return summary
    ? `[图片：${contentId}，OCR 摘要：${summary}]`
    : `[图片：${contentId}]`;
}
