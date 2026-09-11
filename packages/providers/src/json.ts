/**
 * 工具参数 JSON 宽松修复（M4 §4.6）：逐级尝试修复国产模型的格式抖动，核心原则「模型可自纠，不崩溃」。
 */
export function safeParseJson(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // 1. 去尾随逗号
    const noTrailing = raw.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(noTrailing);
    } catch {
      // 2. 去注释
      const noComments = noTrailing.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      try {
        return JSON.parse(noComments);
      } catch {
        // 3. 截断恢复：在最近的 , 或 { 处截断
        const cut = noComments.slice(0, Math.min(noComments.length, 4000));
        const lastBrace = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
        try {
          return JSON.parse(cut.slice(0, lastBrace + 1));
        } catch {
          return { __parseError: raw.slice(0, 200) };
        }
      }
    }
  }
}
