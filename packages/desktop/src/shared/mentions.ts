/**
 * @ 引用（mention）文本解析 — 双端共用纯函数。
 *
 * 语法约定（与 Claude Code 桌面版一致）：
 *   - `@` 必须出现在行首或空白之后（避免误伤邮箱 a@b.com）；
 *   - mention token = `@` 后连续的非空白字符（相对 workspace 的路径，`/` 分隔）；
 *   - 发送时把全部 mention 展开为绝对路径清单附在消息尾部，引擎无需自行解析相对路径。
 */

/** 输入框光标处正在输入的 mention（弹层触发依据）。 */
export interface ActiveMention {
  /** `@` 字符在文本中的下标。 */
  start: number;
  /** @ 之后、光标之前的查询串（可能为空）。 */
  query: string;
}

/** 检测光标位置是否正处于一个 @ mention 内。 */
export function detectMention(text: string, caret: number): ActiveMention | null {
  if (caret <= 0 || caret > text.length) return null;
  // 光标前最后一个 @
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0) return null;
  const query = text.slice(at + 1, caret);
  // @ 与光标之间不能有空白（否则是普通文本的一部分）
  if (/\s/.test(query)) return null;
  // @ 必须在行首或前面是空白（排除邮箱 user@host）
  const prev = at > 0 ? text[at - 1] : '';
  if (prev && !/\s/.test(prev)) return null;
  return { start: at, query };
}

/** mention token 的合法字符（非空白即可），发送前剥掉的尾部标点。 */
const TRAILING_PUNCT = /[.,;:!?)\]}'"，。；：！？）》」』】]+$/;

export interface ExtractedMention {
  /** 相对路径（已剥尾部标点，`/` 分隔）。 */
  relPath: string;
}

/**
 * 从一个 mention token 中提取相对路径。
 *
 * 中文文本通常**不加空格**直接跟在路径后（`@docs/b.md，再看`），token 会把
 * 后续中文一起吸进来 —— 但中文不是合法路径字符，因此在尾部标点剥离之前，
 * 先截断第一个中文字符（CJK 统一表意文字）之后的内容。
 */
function cleanToken(token: string): string {
  // 首个 CJK 字符位置（路径中不应出现中文文件名之外的场景；中文文件名仍可
  // 被 @ 弹层以完整 relPath 插入 —— 那种 token 不含标点，不触发截断）。
  const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.exec(token);
  const base = cjk ? token.slice(0, cjk.index) : token;
  return base.replace(TRAILING_PUNCT, '');
}

/** 提取文本中全部 mention（发送时展开引用清单用）。 */
export function extractMentions(text: string): ExtractedMention[] {
  const out: ExtractedMention[] = [];
  const seen = new Set<string>();
  const re = /@([^\s@]+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index;
    const prev = at > 0 ? text[at - 1] : '';
    // @ 前必须是行首/空白（排除邮箱）；token 里不含 @（正则已保证）
    if (prev && !/\s/.test(prev)) continue;
    const relPath = cleanToken(m[1]!);
    if (!relPath || relPath === '@') continue;
    if (!seen.has(relPath)) {
      seen.add(relPath);
      out.push({ relPath });
    }
  }
  return out;
}

/**
 * 把正在输入的 mention 替换为选中的相对路径（`@path `，尾随空格便于继续输入）。
 * @returns 新文本与新光标位置；超出范围时原样返回。
 */
export function insertMention(
  text: string,
  caret: number,
  start: number,
  relPath: string,
): { text: string; caret: number } {
  if (start < 0 || start > text.length || caret < start || caret > text.length) {
    return { text, caret };
  }
  const next = `${text.slice(0, start)}@${relPath} ${text.slice(caret)}`;
  return { text: next, caret: start + relPath.length + 2 };
}

/**
 * 组装发送文本：把 mention 展开为绝对路径引用清单附在尾部。
 * @param workspaceRoot 会话 workspace 绝对路径
 * @param mentions 插入时记录的类型信息（isDir），手打的 mention 默认按文件处理
 */
export function buildTextWithMentions(
  text: string,
  workspaceRoot: string,
  isDirOf: (relPath: string) => boolean | undefined,
): string {
  const mentions = extractMentions(text);
  if (mentions.length === 0) return text;
  const lines = mentions.map((m) => {
    const abs = joinPath(workspaceRoot, m.relPath);
    const isDir = isDirOf(m.relPath);
    return `- ${abs}${isDir ? '（文件夹）' : ''}`;
  });
  return `${text}\n\n[引用文件/文件夹，以下均为绝对路径]\n${lines.join('\n')}`;
}

/** 拼接 workspace 与相对路径（纯字符串实现：渲染进程沙箱内无 node:path）。 */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const r = root.replace(/[\\/]+$/, '');
  const relNorm = rel.replace(/\//g, sep);
  return `${r}${sep}${relNorm}`;
}
