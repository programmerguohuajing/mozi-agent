/**
 * MCP Tools 适配器（M8 §8.5）：把 server 的工具封装为 mozi 的 AgentTool。
 * 名称加 <serverId>__ 前缀防跨 server 重名；content 块渲染为文本（截断），
 * image/audio 落盘引用，resource 转文本摘要。AbortSignal 联动取消。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { RiskLevel, ToolResult } from '@mozi/shared';
import type { AgentTool, JSONSchema, ToolContext } from '@mozi/tools';
import type { ContentBlock, McpToolDef } from './types.js';

const MAX_DESC = 1000;

export class McpToolAdapter implements AgentTool {
  readonly name: string;
  readonly version = '1.0.0';
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly riskLevel: RiskLevel = 'meta';

  constructor(
    private conn: {
      serverId: string;
      callTool: (
        n: string,
        a: Record<string, unknown>,
        o: { signal?: AbortSignal; timeoutMs?: number; progressToken?: string },
      ) => Promise<import('./types.js').ToolCallResult>;
    },
    private serverTool: McpToolDef,
  ) {
    this.name = `${conn.serverId}__${serverTool.name}`;
    const base = serverTool.description ?? serverTool.title ?? '';
    this.description =
      base.length > MAX_DESC
        ? `${base.slice(0, MAX_DESC)}…[truncated]`
        : base || `MCP tool ${serverTool.name} from ${conn.serverId}`;
    this.parameters = serverTool.inputSchema;
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let progressToken: string | undefined;
    try {
      const result = await this.conn.callTool(this.serverTool.name, input, {
        signal: ctx.signal,
        timeoutMs: 60_000,
        progressToken,
      });
      const rendered = await renderContent(result.content, ctx);
      const isError = result.isError === true;
      return {
        callId: '',
        content: rendered,
        isError,
        display: {
          kind: 'json',
          data: {
            server: this.conn.serverId,
            tool: this.serverTool.name,
            args: input,
            truncated: false,
          },
        },
      };
    } catch (err) {
      return {
        callId: '',
        content: `MCP tool error: ${(err as Error).message}`,
        isError: true,
        meta: { errorKind: 'mcp_tool_failed' },
      };
    }
  }
}

/** 把 MCP content 块渲染为模型可读文本，image/audio 落盘为路径引用。 */
async function renderContent(blocks: ContentBlock[], ctx: ToolContext): Promise<string> {
  const parts: string[] = [];
  let mediaIdx = 0;
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text);
    } else if (b.type === 'image' || b.type === 'audio') {
      const ext = b.type === 'image' ? mimeExt(b.mimeType) : mimeExt(b.mimeType);
      const path = await saveMedia(ctx, b.data, ext, mediaIdx++);
      parts.push(`[${b.type}] saved to ${path}`);
    } else if (b.type === 'resource') {
      const r = b.resource;
      const preview = (r.text ?? '').slice(0, 200);
      parts.push(`[resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}] ${preview}`);
    } else if (b.type === 'resource_link') {
      parts.push(`[resource_link ${b.uri} (${b.name})]`);
    }
  }
  return parts.join('\n');
}

function mimeExt(mime?: string): string {
  if (!mime) return 'bin';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

async function saveMedia(
  ctx: ToolContext,
  data: string,
  ext: string,
  idx: number,
): Promise<string> {
  const dir = `${ctx.workspace.root}/.mozi/media`;
  try {
    await mkdir(dir, { recursive: true });
    const file = `${dir}/${Date.now()}-${idx}.${ext}`;
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  } catch {
    return `<media ${ext} not persisted>`;
  }
}
