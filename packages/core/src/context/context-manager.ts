/**
 * 上下文管理（M5 §5.3/§5.5 + M2 接线）：系统提示 + AGENTS.md 注入 + 历史裁剪 + 文件新鲜度。
 * Auto-Compact 的触发与执行在引擎侧（见 context/compactor.ts），此处只负责组装与注入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage, SystemMessage } from '@mozi/shared';
import type { Session } from '../session/session-store.js';
import { estimateMessageTokens } from './compactor.js';

const BASE_SYSTEM = `You are Mozi (墨子), an autonomous coding agent. You help users with software engineering tasks.

Operating principles:
- Think step by step. When a task needs file changes, first read the relevant files, then act.
- Prefer small, correct changes. After making changes you can verify with the shell tool.
- Use the available tools (read_file, write_file, glob, grep, shell) to gather context and apply changes.
- For tasks with more than 5 steps, first create a plan with the todo_list tool and update it as you complete each item.
- When you are done, respond with a concise summary of what you changed. Do not invent files outside the workspace.
- All file paths are relative to the workspace root unless an absolute path is explicitly required.`;

export interface ContextManagerOptions {
  systemPrompt?: string;
  workspaceRoot: string;
  maxMessages?: number;
  /** 上下文 token 预算（默认取 session.config.context.maxTokens ?? 128k）。 */
  budgetTokens?: number;
}

export interface BuildView {
  messages: ChatMessage[];
  /** 估算的上下文体量（含 system），供压缩触发判断。 */
  estimatedTokens: number;
  /** 注入的顶层系统提示文本（诊断用）。 */
  systemText: string;
}

export class ContextManager {
  constructor(private readonly opts: ContextManagerOptions) {}

  build(session: Session, extra?: { dirtyFiles?: string[] }): BuildView {
    const agents = this.loadAgentsMd();
    const parts = [this.opts.systemPrompt ?? BASE_SYSTEM];
    if (agents) parts.push(agents);
    // 文件新鲜度提示（§5.6）：自上次读取后被修改的文件。
    const dirty = extra?.dirtyFiles ?? [];
    if (dirty.length) {
      const list = dirty
        .map((f) => `- ${f}`)
        .join('\n');
      parts.push(
        `[注意] 以下文件自上次读取后已被修改，请重新 read_file 确认最新内容：\n${list}`,
      );
    }
    const systemText = parts.join('\n\n');
    const system: SystemMessage = { role: 'system', content: systemText };
    let msgs = session.messages;
    const cap = this.opts.maxMessages ?? 60;
    if (msgs.length > cap) msgs = msgs.slice(msgs.length - cap);
    const messages = [system, ...msgs];
    const estimatedTokens = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    return { messages, estimatedTokens, systemText };
  }

  /** 上下文预算：显式 opts 优先，其次 session 配置，最后 128k。 */
  budgetFor(session: Session): number {
    if (typeof this.opts.budgetTokens === 'number') return this.opts.budgetTokens;
    return session.config.context.maxTokens ?? 128_000;
  }

  private loadAgentsMd(): string {
    const candidates = [
      path.join(this.opts.workspaceRoot, 'AGENTS.md'),
      path.join(os.homedir(), '.mozi', 'AGENTS.md'),
    ];
    const parts: string[] = [];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          parts.push(
            `<AGENTS.md ${c}>\n${fs.readFileSync(c, 'utf8').slice(0, 4000)}\n</AGENTS.md>`,
          );
        }
      } catch {
        /* ignore */
      }
    }
    return parts.join('\n');
  }
}
