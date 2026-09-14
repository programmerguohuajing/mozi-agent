/**
 * 把提示词资源（src/prompts/**.md）复制到 dist/prompts/。
 *
 * 为什么需要这一步：`tsc` 只处理 TS，不会把 .md 带进产物；而运行期
 * `PromptAssets` 是按文件路径读取 prompts/ 目录的（版本化唯一真源）。
 * 缺少该步骤时，任何以 `@mozi/core/dist` 为运行形态的场景都会报
 * 「prompts 目录未找到（identity.md 缺失）」。
 *
 * 用法：
 *   node packages/core/scripts/copy-prompts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(HERE, '..');
const SRC_DIR = path.join(CORE_DIR, 'src', 'prompts');
const DEST_DIR = path.join(CORE_DIR, 'dist', 'prompts');

/** 递归复制 .md（保留 capabilities/ policy/ 子目录结构）。 */
function copyMarkdown(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) count += copyMarkdown(src, dest);
    else if (entry.name.endsWith('.md')) {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

if (!fs.existsSync(path.join(SRC_DIR, 'identity.md'))) {
  console.error(`[copy-prompts] 源目录缺少 identity.md：${SRC_DIR}`);
  process.exit(1);
}

const copied = copyMarkdown(SRC_DIR, DEST_DIR);

// 自检：目标目录必须真的含 identity.md，否则产物依旧不可用。
if (!fs.existsSync(path.join(DEST_DIR, 'identity.md'))) {
  console.error(`[copy-prompts] 复制后仍缺少 ${path.join(DEST_DIR, 'identity.md')}`);
  process.exit(1);
}

console.log(`[copy-prompts] ${copied} 个 .md -> ${path.relative(CORE_DIR, DEST_DIR)}`);
