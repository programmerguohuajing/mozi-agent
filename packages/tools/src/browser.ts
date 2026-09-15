/**
 * 内置浏览器工具：让 agent 在桌面端直接浏览网页、截图、提取内容、交互。
 *
 * 架构：BrowserAccess 接口注入（类似 MemoryAccess / VisionAccess）。
 *   - 桌面端：Electron BrowserView / WebContentsView（Chromium 内核）
 *   - CLI：HTTP fetch 降级（navigate/getText/getHtml 基本操作）
 *   - 未注入：返回明确错误
 *
 * riskLevel: 'read'（navigate/getText/getHtml/screenshot/listTabs）
 *   click/fill/eval 操作仍需策略审批（在工具描述中标注交互性）。
 */
import type { AgentTool, ToolContext } from './types.js';
import { fail, ok, truncate } from './types.js';

type BrowserAction =
  | 'navigate'
  | 'screenshot'
  | 'annotate'
  | 'get_text'
  | 'get_html'
  | 'click'
  | 'fill'
  | 'eval'
  | 'close'
  | 'list_tabs';

interface BrowserInput {
  action: BrowserAction;
  /** 目标 URL（navigate）。 */
  url?: string;
  /** 等待时间毫秒（navigate），默认 2000。 */
  waitMs?: number;
  /** CSS 选择器（click/fill）。 */
  selector?: string;
  /** 填充值（fill）。 */
  value?: string;
  /** JavaScript 脚本（eval）。 */
  script?: string;
  /** 全页截图（screenshot/annotate），默认 false。 */
  fullPage?: boolean;
  /** 标注提示文字（annotate），用于在截图中高亮区域。 */
  highlight?: string;
  /** 标注区域选择器（annotate），高亮指定元素。 */
  highlightSelector?: string;
}

export const browserTool: AgentTool<BrowserInput> = {
  name: 'browser',
  version: '1.0.0',
  riskLevel: 'read',
  description: [
    'Built-in browser tool for web browsing, content extraction, and interaction.',
    'Actions: navigate (open URL), screenshot (capture page), annotate (capture + highlight for user review),',
    'get_text (extract text), get_html (get page HTML), click (click element by CSS selector),',
    'fill (fill form field), eval (run JavaScript), close (close browser), list_tabs (list open tabs).',
    'Desktop uses Electron BrowserView; CLI falls back to HTTP fetch.',
    'Note: click/fill/eval are interactive operations subject to policy approval.',
    'annotate: captures screenshot with optional highlight overlay; user can mark areas in desktop UI before sending to agent.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'navigate',
          'screenshot',
          'annotate',
          'get_text',
          'get_html',
          'click',
          'fill',
          'eval',
          'close',
          'list_tabs',
        ],
        description: 'Browser action to perform.',
      },
      url: {
        type: 'string',
        description: 'Target URL for navigate action.',
      },
      waitMs: {
        type: 'number',
        description: 'Wait time in ms after navigation (default: 2000).',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for click/fill actions.',
      },
      value: {
        type: 'string',
        description: 'Value to fill (for fill action).',
      },
      script: {
        type: 'string',
        description: 'JavaScript to evaluate (for eval action).',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page screenshot (default: false).',
      },
      highlight: {
        type: 'string',
        description: 'Highlight label text for annotate action (overlay on screenshot).',
      },
      highlightSelector: {
        type: 'string',
        description: 'CSS selector to highlight in annotate action (draws red box around element).',
      },
    },
    required: ['action'],
  },
  async execute(input: BrowserInput, ctx: ToolContext) {
    if (!ctx.browser) {
      return fail(
        'Browser access not available. This feature requires the desktop app with Electron or a browser provider. In CLI mode, only HTTP fetch fallback is available for basic operations.',
        'no_browser_access',
      );
    }

    const browser = ctx.browser;

    switch (input.action) {
      case 'navigate': {
        if (!input.url) return fail('navigate requires a url parameter', 'missing_url');
        try {
          const result = await browser.navigate(input.url, { waitMs: input.waitMs ?? 2000 });
          return ok(JSON.stringify(result, null, 2));
        } catch (e) {
          return fail(
            `Navigation failed: ${e instanceof Error ? e.message : String(e)}`,
            'nav_error',
          );
        }
      }

      case 'screenshot': {
        try {
          const result = await browser.screenshot({ fullPage: input.fullPage ?? false });
          return ok(
            `Screenshot captured: ${result.contentId} (${result.base64.length} bytes base64)`,
          );
        } catch (e) {
          return fail(
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
            'screenshot_error',
          );
        }
      }

      case 'annotate': {
        // 截图 + 可选高亮区域，供桌面端用户在 UI 中标注后保存到输入框
        try {
          // 如果指定了 highlightSelector，先在页面上画红色框高亮目标元素
          if (input.highlightSelector) {
            await browser.eval(`(() => {
              const el = document.querySelector(${JSON.stringify(input.highlightSelector)});
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const overlay = document.createElement('div');
              overlay.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top +
                'px;width:' + rect.width + 'px;height:' + rect.height +
                'px;border:3px solid #ef4444;z-index:999999;pointer-events:none;box-sizing:border-box;';
              overlay.id = '__mozi_highlight__';
              document.body.appendChild(overlay);
            })()`);
          }
          const result = await browser.screenshot({ fullPage: input.fullPage ?? false });
          // 清理高亮覆盖层
          if (input.highlightSelector) {
            await browser.eval(`document.getElementById('__mozi_highlight__')?.remove()`);
          }
          const highlightInfo = input.highlight ? ` (highlight: ${input.highlight})` : '';
          const selectorInfo = input.highlightSelector
            ? ` (selector: ${input.highlightSelector})`
            : '';
          return ok(
            `Annotated screenshot captured: ${result.contentId} (${result.base64.length} bytes base64)${highlightInfo}${selectorInfo}`,
            { kind: 'image', contentId: result.contentId, base64: result.base64 } as never,
          );
        } catch (e) {
          return fail(
            `Annotate failed: ${e instanceof Error ? e.message : String(e)}`,
            'annotate_error',
          );
        }
      }

      case 'get_text': {
        try {
          const result = await browser.getText();
          const { text, truncated } = truncate(result.text, 200, 50);
          return ok(text, { kind: 'text', truncated } as never);
        } catch (e) {
          return fail(
            `Get text failed: ${e instanceof Error ? e.message : String(e)}`,
            'get_text_error',
          );
        }
      }

      case 'get_html': {
        try {
          const result = await browser.getHtml();
          const { text, truncated } = truncate(result.html, 200, 50);
          return ok(text, { kind: 'text', truncated } as never);
        } catch (e) {
          return fail(
            `Get HTML failed: ${e instanceof Error ? e.message : String(e)}`,
            'get_html_error',
          );
        }
      }

      case 'click': {
        if (!input.selector) return fail('click requires a selector parameter', 'missing_selector');
        try {
          const result = await browser.click(input.selector);
          if (!result.ok) return fail(`Click failed: ${result.error ?? 'unknown'}`, 'click_error');
          return ok(`Clicked: ${input.selector}`);
        } catch (e) {
          return fail(`Click failed: ${e instanceof Error ? e.message : String(e)}`, 'click_error');
        }
      }

      case 'fill': {
        if (!input.selector) return fail('fill requires a selector parameter', 'missing_selector');
        if (input.value === undefined)
          return fail('fill requires a value parameter', 'missing_value');
        try {
          const result = await browser.fill(input.selector, input.value);
          if (!result.ok) return fail(`Fill failed: ${result.error ?? 'unknown'}`, 'fill_error');
          return ok(`Filled ${input.selector} with value (${input.value.length} chars)`);
        } catch (e) {
          return fail(`Fill failed: ${e instanceof Error ? e.message : String(e)}`, 'fill_error');
        }
      }

      case 'eval': {
        if (!input.script) return fail('eval requires a script parameter', 'missing_script');
        try {
          const result = await browser.eval(input.script);
          if (result.error) return fail(`Eval error: ${result.error}`, 'eval_error');
          const resultStr =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result, null, 2);
          const { text, truncated } = truncate(resultStr || '(undefined)', 200, 50);
          return ok(text, { kind: 'text', truncated } as never);
        } catch (e) {
          return fail(`Eval failed: ${e instanceof Error ? e.message : String(e)}`, 'eval_error');
        }
      }

      case 'close': {
        try {
          await browser.close();
          return ok('Browser closed');
        } catch (e) {
          return fail(`Close failed: ${e instanceof Error ? e.message : String(e)}`, 'close_error');
        }
      }

      case 'list_tabs': {
        try {
          const tabs = await browser.listTabs();
          return ok(JSON.stringify(tabs, null, 2));
        } catch (e) {
          return fail(
            `List tabs failed: ${e instanceof Error ? e.message : String(e)}`,
            'list_tabs_error',
          );
        }
      }

      default:
        return fail(`Unknown browser action: ${input.action}`, 'unknown_action');
    }
  },
};
