// 初始化评测仓库：node setup.mjs <workspace>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node setup.mjs <workspace>');

writeFileSync(
  join(dir, 'webhook.js'),
  `// TODO: 加 HMAC-SHA256 签名（见 task.md）
export function handleWebhook(body, signature, secret) {
  return { ok: true, event: body.event };
}
`,
);
