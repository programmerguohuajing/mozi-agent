/**
 * 会话存储：事件溯源持久化（JSONL 追加写 + meta.json）+ resume 重放（M7）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  ChatMessage,
  SessionConfig,
  SessionLimits,
  TokenUsage,
} from '@mozi/shared';
import { DEFAULT_LIMITS as LIMITS, defaultConfig } from '@mozi/shared';

/** 会话级 todo 项（详细设计 §3.3.7）。 */
export interface TodoTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  detail?: string;
}

export interface Session {
  id: string;
  config: SessionConfig;
  limits: SessionLimits;
  messages: ChatMessage[];
  usage: TokenUsage;
  running: boolean;
  /** 会话级可变元数据（todo 列表、压缩计数等）。 */
  meta: SessionMeta;
  /** 子智能体嵌套深度（主会话 = 0，M12 §12.5）。 */
  depth: number;
  /** 本会话（作为父）在本轮已派发的子 Agent 数量。 */
  subSpawnCount: number;
  /** 若为子会话：父会话 id。 */
  parentSessionId?: string;
  /** 若为子会话：模板类型（explore/general/…）。 */
  agentType?: string;
}

export interface SessionMeta {
  /** 会话级 todo 列表（todo_list 工具读写）。 */
  todos?: TodoTask[];
  /** 距上次 Auto-Compact 的轮数（§5.4 minIntervalTurns）；-1 表示从未压缩过。 */
  turnsSinceLastCompact: number;
  /** 累计压缩次数（诊断用）。 */
  compactCount: number;
  /** 父会话 id（子会话落盘冗余，便于 subs 查询）。 */
  parentSessionId?: string;
  agentType?: string;
  /** 其他会话级扩展字段（工具可通过 ToolContext.session.meta 读写）。 */
  [key: string]: unknown;
}

export class SessionStore {
  constructor(private readonly baseDir: string) {}

  private dir(id: string): string {
    return path.join(this.baseDir, id);
  }
  private eventsPath(id: string): string {
    return path.join(this.dir(id), 'events.jsonl');
  }
  private metaPath(id: string): string {
    return path.join(this.dir(id), 'meta.json');
  }

  loadOrCreate(id: string, configOverride?: Partial<SessionConfig>): Session {
    const dir = this.dir(id);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.eventsPath(id))) return this.resume(id);
    const config: SessionConfig = { ...defaultConfig(), ...(configOverride ?? {}) };
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: config.models.executor,
    };
    const session: Session = {
      id,
      config,
      limits: { ...LIMITS, ...(config.limits ?? {}) },
      messages: [],
      usage,
      running: false,
      meta: { turnsSinceLastCompact: -1, compactCount: 0 },
      depth: 0,
      subSpawnCount: 0,
    };
    this.writeMeta(id, session);
    return session;
  }

  resume(id: string): Session {
    const events = this.readEvents(id);
    let config = defaultConfig();
    let savedMeta: Partial<SessionMeta> = {};
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8'));
      if (meta?.config) config = meta.config as SessionConfig;
      if (meta?.todos) savedMeta.todos = meta.todos;
      if (typeof meta?.compactCount === 'number') savedMeta.compactCount = meta.compactCount;
    } catch {
      /* ignore */
    }
    const messages: ChatMessage[] = [];
    for (const ev of events) {
      if (ev.type === 'turn.started') {
        messages.push({ role: 'user', content: [{ type: 'text', text: ev.input }] });
      } else if (ev.type === 'message.completed') {
        messages.push(ev.message);
      } else if (ev.type === 'tool.completed') {
        messages.push({
          role: 'tool',
          callId: ev.callId,
          content: ev.result.content,
          isError: ev.result.isError,
        });
      }
    }
    const limits = { ...LIMITS, ...(config.limits ?? {}) };
    const usage = totalUsage(events);
    const meta: SessionMeta = {
      turnsSinceLastCompact: -1,
      compactCount: savedMeta.compactCount ?? 0,
      ...(savedMeta.todos ? { todos: savedMeta.todos } : {}),
    };
    return {
      id,
      config,
      limits,
      messages,
      usage,
      running: false,
      meta,
      depth: 0,
      subSpawnCount: 0,
    };
  }

  /** 持久化会话级元数据（todo 列表等），resume 时恢复。 */
  saveMeta(id: string, meta: SessionMeta): void {
    try {
      const p = this.metaPath(id);
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
      raw.todos = meta.todos;
      raw.compactCount = meta.compactCount;
      raw.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(raw, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /**
   * 合成子会话（M12 §12.2）：不落盘到独立顶层目录，而是写入父会话的 subs/<subId>/。
   * 子会话拥有独立的 messages / usage / ContextManager / 策略，与父互不阻塞。
   */
  createSub(
    parent: Session,
    spec: { subId: string; template: string; config: Partial<SessionConfig> },
  ): Session {
    const parentDir = this.dir(parent.id);
    const subDir = path.join(parentDir, 'subs', spec.subId);
    fs.mkdirSync(subDir, { recursive: true });
    const config: SessionConfig = { ...parent.config, ...spec.config };
    const sub: Session = {
      id: `${parent.id}/subs/${spec.subId}`,
      config,
      limits: { ...parent.limits, ...(config.limits ?? {}) },
      messages: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: config.models.executor,
      },
      running: false,
      meta: {
        turnsSinceLastCompact: -1,
        compactCount: 0,
        parentSessionId: parent.id,
        agentType: spec.template,
      },
      depth: parent.depth + 1,
      subSpawnCount: 0,
      parentSessionId: parent.id,
      agentType: spec.template,
    };
    const meta = {
      sessionId: sub.id,
      parentSessionId: parent.id,
      agentType: spec.template,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: config.models.executor,
      status: 'idle',
      usageTotal: sub.usage,
      config,
    };
    try {
      fs.writeFileSync(path.join(subDir, 'meta.json'), JSON.stringify(meta, null, 2));
    } catch {
      /* best-effort */
    }
    return sub;
  }

  appendEvent(id: string, ev: AgentEvent): void {
    try {
      fs.mkdirSync(path.dirname(this.eventsPath(id)), { recursive: true });
      fs.appendFileSync(this.eventsPath(id), `${JSON.stringify(ev)}\n`);
    } catch {
      /* persistence best-effort: in-memory events still delivered to consumers */
    }
  }

  updateRunning(id: string, running: boolean): void {
    try {
      const p = this.metaPath(id);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
      meta.running = running;
      meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(meta, null, 2));
    } catch {
      /* ignore */
    }
  }

  private writeMeta(id: string, s: Session): void {
    const meta = {
      sessionId: id,
      workspace: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: s.config.models.executor,
      status: 'idle',
      usageTotal: s.usage,
      config: s.config,
      depth: s.depth,
      parentSessionId: s.parentSessionId,
      agentType: s.agentType,
      subCount: 0,
    };
    fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
  }

  private readEvents(id: string): AgentEvent[] {
    const p = this.eventsPath(id);
    if (!fs.existsSync(p)) return [];
    const text = fs.readFileSync(p, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').map((l) => JSON.parse(l) as AgentEvent);
  }

  /**
   * 会话分叉（M7）：把 srcId 的前 atEventIndex 条事件复制到 newId，两侧独立演进、各自可 resume。
   * @param atEventIndex 复制的事件条数（默认全部）；用于「回到某一步重开」。
   */
  fork(srcId: string, atEventIndex?: number, newId?: string): Session {
    const target = newId ?? `${srcId}_fork_${Date.now().toString(36)}`;
    const dir = this.dir(target);
    fs.mkdirSync(dir, { recursive: true });
    const events = this.readEvents(srcId);
    const slice = typeof atEventIndex === 'number' ? events.slice(0, atEventIndex) : events;
    const dst = this.eventsPath(target);
    fs.writeFileSync(dst, slice.map((e) => `${JSON.stringify(e)}\n`).join(''));
    // 复制 meta 并改写为新会话身份。
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(this.metaPath(srcId), 'utf8'));
    } catch {
      /* ignore */
    }
    meta.sessionId = target;
    meta.forkedFrom = srcId;
    meta.forkedAt = new Date().toISOString();
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.metaPath(target), JSON.stringify(meta, null, 2));
    return this.resume(target);
  }

  /**
   * 会话回收（M7）：updatedAt 早于 retentionDays 的会话移入 .trash/<id>，可 restore。
   * @returns 被回收的会话 id 列表。
   */
  gc(retentionDays = 30): string[] {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const trashDir = path.join(this.baseDir, '.trash');
    const moved: string[] = [];
    for (const entry of this.list()) {
      const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : 0;
      if (updatedAt && updatedAt >= cutoff) continue;
      try {
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(this.dir(entry.id), path.join(trashDir, entry.id));
        moved.push(entry.id);
      } catch {
        /* 单个失败不影响整体 */
      }
    }
    return moved;
  }

  /** 从回收站恢复会话（M7）。 */
  restore(id: string): boolean {
    const trash = path.join(this.baseDir, '.trash', id);
    if (!fs.existsSync(trash)) return false;
    try {
      fs.renameSync(trash, this.dir(id));
      return true;
    } catch {
      return false;
    }
  }

  /** 列出回收站中的会话。 */
  listTrashed(): string[] {
    try {
      return fs.readdirSync(path.join(this.baseDir, '.trash'));
    } catch {
      return [];
    }
  }

  list(): Array<{ id: string; model?: string; updatedAt?: string; status?: string }> {
    try {
      return fs
        .readdirSync(this.baseDir)
        .filter((d) => !d.startsWith('.') && fs.existsSync(this.eventsPath(d)))
        .map((d) => {
          try {
            const m = JSON.parse(fs.readFileSync(this.metaPath(d), 'utf8'));
            return { id: d, model: m.model, updatedAt: m.updatedAt, status: m.status };
          } catch {
            return { id: d };
          }
        });
    } catch {
      return [];
    }
  }
}

function totalUsage(events: AgentEvent[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let total = 0;
  let model = '';
  for (const ev of events) {
    if ((ev.type === 'token.usage' || ev.type === 'turn.completed') && ev.usage) {
      inputTokens += ev.usage.inputTokens;
      outputTokens += ev.usage.outputTokens;
      total += ev.usage.totalTokens;
      model = ev.usage.model;
    }
  }
  return { inputTokens, outputTokens, totalTokens: total, model };
}
