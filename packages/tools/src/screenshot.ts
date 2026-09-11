/**
 * screenshot：agent 主动获取视觉输入（M17 §17.3）。riskLevel = read。
 * 需要屏幕录制权限（首次调用系统弹授权）。
 *
 * 实现落在 core 的图片管线（VisionAccess）；本工具只做参数校验与结果渲染，
 * 保持 tools 包不依赖平台 API。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok, truncate } from './types.js';

interface ScreenshotInput {
  target?:
    | { kind: 'screen' }
    | { kind: 'window'; title: string }
    | { kind: 'browser'; url: string; waitMs?: number; fullPage?: boolean };
  annotate?: { highlight?: string };
}

export const screenshotTool: AgentTool<ScreenshotInput> = {
  name: 'screenshot',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Capture a screenshot to inspect visual state: the screen, a specific window, or a web page rendered',
    'by a headless browser. Use it to verify UI changes, read error dialogs, or compare against an',
    'expectation. Typical flow: start dev server, sleep, screenshot the localhost URL, fix, screenshot again.',
    'The result is saved as an image file and accompanied by a truncated OCR text summary so you can read',
    'the content even without vision.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        description:
          'What to capture. Defaults to the whole screen. "browser" loads the url in a headless browser first.',
        properties: {
          kind: { type: 'string', enum: ['screen', 'window', 'browser'] },
          title: { type: 'string', description: 'Window title (kind="window").' },
          url: { type: 'string', description: 'Page URL (kind="browser").' },
          waitMs: { type: 'integer', description: 'Wait before capture (kind="browser").' },
          fullPage: { type: 'boolean', description: 'Capture full scrollable page (kind="browser").' },
        },
        required: ['kind'],
      },
      annotate: {
        type: 'object',
        description: 'Optional: draw a highlight box around OCR-located text.',
        properties: { highlight: { type: 'string' } },
      },
    },
  },
  async execute(input: ScreenshotInput, ctx: ToolContext) {
    if (!ctx.vision) {
      return fail('screenshot is not available on this platform/session', 'no-vision');
    }
    const target = input.target ?? { kind: 'screen' as const };
    if (target.kind === 'window' && !target.title) {
      return fail('target.kind="window" requires a title', 'bad-args');
    }
    if (target.kind === 'browser' && !target.url) {
      return fail('target.kind="browser" requires a url', 'bad-args');
    }
    try {
      const res = await ctx.vision.screenshot({
        target,
        ...(input.annotate ? { annotate: input.annotate } : {}),
      });
      const head = `<screenshot path="${res.path}" contentId="${res.contentId}"${
        res.browser ? ' mode="browser"' : ''
      }${typeof res.estimatedTokens === 'number' ? ` tokens≈${res.estimatedTokens}` : ''}>`;
      const body = res.ocrText
        ? `\nOCR summary:\n${truncate(res.ocrText, 40, 10).text}`
        : '\n(no OCR text extracted)';
      return ok(`${head}${body}\n</screenshot>`, {
        kind: 'image',
        path: res.path,
        contentId: res.contentId,
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), 'screenshot-failed');
    }
  },
};
