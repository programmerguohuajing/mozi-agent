#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  InteractiveApprovalGateway,
  SessionStore,
  autoApproveGateway,
  createEngine,
} from '@mozi/core';
import { OpenAICompatibleProvider, ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import type { AgentEvent, ApprovalReason } from '@mozi/shared';
import type { PolicyMode } from '@mozi/shared';
/**
 * mozi CLI 入口（M1 最小集）：commander + 朴素 readline REPL + `mozi exec --json` 非交互模式。
 * Ink 富交互 UI 为 M2+；本文件只做事件流消费与审批应答，不含业务逻辑。
 */
import { Command } from 'commander';
import { listSnapshots, undoLast } from '@mozi/tools';
import { nextRunAt } from '@mozi/core';
import {
  taskAdd,
  taskDoctor,
  taskGc,
  taskList,
  taskRemove,
  taskRun,
  taskSetEnabled,
  taskTick,
  registerTaskCommands,
} from './task.js';
import { registerRemoteCommands, serve } from './remote.js';

const HOME = os.homedir();
const SESSION_DIR = process.env.MOZI_SESSION_DIR ?? path.join(HOME, '.mozi', 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

interface ProviderInfo {
  reg: ProviderRegistry;
  model: string;
  live: boolean;
}

function buildProvider(): ProviderInfo {
  const reg = new ProviderRegistry();
  const base = process.env.MOZI_BASE_URL;
  const key = process.env.MOZI_API_KEY;
  const model = process.env.MOZI_MODEL ?? 'deepseek-chat';
  if (base && key) {
    const provider = new OpenAICompatibleProvider({ baseUrl: base, apiKey: () => key, model });
    reg.register(provider);
    reg.alias('executor', model);
    reg.alias(model, model);
    reg.alias('deepseek-chat', model); // 引擎默认 executor 名 → 实际 provider
    return { reg, model, live: true };
  }
  const demo = new ScriptedProvider(
    [
      {
        content:
          'Mozi 离线演示模式：未检测到 MOZI_BASE_URL / MOZI_API_KEY。\n配置后（支持 DeepSeek / Qwen / GLM / Ollama 等任意 OpenAI 兼容端点）即可使用真实模型。',
      },
    ],
    'demo',
    model,
  );
  reg.register(demo);
  reg.alias('executor', 'demo');
  reg.alias(model, 'demo');
  reg.alias('deepseek-chat', 'demo'); // 引擎默认 executor 名 → demo
  return { reg, model, live: false };
}

function short(text: string, n = 120): string {
  const first = text.split('\n')[0] ?? '';
  return first.length > n ? `${first.slice(0, n)}…` : first;
}

function renderEvent(ev: AgentEvent): void {
  switch (ev.type) {
    case 'message.delta':
      process.stdout.write(ev.text);
      break;
    case 'message.completed':
      if (ev.message.content) console.log(`\n${ev.message.content}`);
      break;
    case 'tool.requested':
      console.log(`\n→ ${ev.call.name}(${JSON.stringify(ev.call.arguments)})`);
      break;
    case 'tool.approval.required':
      console.log(`\n⚠ 需要批准: ${ev.call.name}`);
      break;
    case 'tool.completed':
      console.log(`  ${ev.result.isError ? '✗' : '✓'} ${ev.callId} ${short(ev.result.content)}`);
      break;
    case 'turn.completed':
      console.log(
        `\n[turn done · ${ev.steps} step(s) · tokens in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}]`,
      );
      break;
    case 'task.completed':
      console.log(`\n✅ task.completed (${ev.reason})`);
      break;
    // ── M2：上下文压缩 / 子智能体卡片（§5.4 / §12.11）──
    case 'context.compacted':
      console.log(
        `\n🗜  上下文已压缩：移除 ${ev.removedTurns} 条消息，节省 ~${ev.savedTokens} tokens`,
      );
      break;
    case 'subagent.started':
      console.log(`\n◐ ${ev.subSessionId.split('/').pop()} [${ev.agentType}] ${short(ev.prompt, 80)}`);
      break;
    case 'subagent.queued':
      console.log(`  ● 子智能体排队中（第 ${ev.queuePosition} 位）`);
      break;
    case 'subagent.progress':
      if (ev.currentTool) console.log(`    · ${ev.maxSteps ? `step ${ev.step}/${ev.maxSteps} ` : ''}${ev.currentTool}`);
      break;
    case 'subagent.approval.required':
      console.log(`\n⚠ [子智能体 ${ev.agentType}] 请求执行: ${ev.call.name}`);
      break;
    case 'subagent.completed':
      console.log(
        `  ✔ 子智能体完成 · ${Math.round(ev.durationMs / 1000)}s · ${ev.steps} step(s) · ${ev.usage.totalTokens} tokens`,
      );
      break;
    case 'subagent.failed':
      console.error(`  ✗ 子智能体失败：${ev.error.code} ${ev.error.message}`);
      break;
    case 'error':
      console.error(`\n❌ error: ${ev.error.code} ${ev.error.message}`);
      break;
    case 'cost.warning':
      console.warn(`\n💰 ${ev.message}`);
      break;
    default:
      break;
  }
}

async function runExec(
  prompt: string,
  opts: { json?: boolean; session?: string; policy?: string; yes?: boolean },
): Promise<number> {
  const { reg, live } = buildProvider();
  const policyMode = (opts.policy as PolicyMode) ?? 'auto';
  const approval =
    opts.yes || policyMode === 'full-auto'
      ? autoApproveGateway('allow')
      : autoApproveGateway('deny');
  const engine = createEngine({
    sessionDir: SESSION_DIR,
    workspaceRoot: process.cwd(),
    providers: reg,
    approval,
    policyMode,
    // 子智能体桥接事件（progress/approval/completed）经宿主通道即时输出（M12 §12.8）。
    onEvent: (ev) => {
      if (opts.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
      else renderEvent(ev);
    },
  });
  const sid = opts.session ?? `exec-${Date.now().toString(36)}`;
  if (!live) console.error('[mozi] 提示: 当前为离线演示模式，未连接真实模型。\n');

  let code = 0;
  const events = engine.run({ sessionId: sid, text: prompt });
  for await (const ev of events) {
    if (opts.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
    else renderEvent(ev);
    if (ev.type === 'error') code = 1;
  }
  return code;
}

async function runRepl(): Promise<void> {
  const { reg, live } = buildProvider();
  const approval = new InteractiveApprovalGateway();
  const engine = createEngine({
    sessionDir: SESSION_DIR,
    workspaceRoot: process.cwd(),
    providers: reg,
    approval,
    policyMode: 'auto',
  });
  const sid = `repl-${Date.now().toString(36)}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!live) console.log('Mozi REPL（离线演示模式）。输入任务开始；输入 exit 退出。\n');
  else console.log('Mozi REPL。输入任务开始；exit 退出；/undo 撤销最近一次文件修改。\n');

  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, (a) => res(a)));

  /** 审批卡片渲染（父会话与子智能体共用，M6 §6.2 结构化风险明细 + M12 §12.7 冒泡）。 */
  const presentApproval = async (
    prefix: string,
    call: { name: string },
    reason: ApprovalReason,
  ): Promise<void> => {
    const r = reason;
    if (r.kind === 'risk') {
      console.log(`\n⚠ ${prefix} 需要批准: ${call.name}（命令风险分析）`);
      for (const seg of r.segments) {
        const mark = seg.color === 'red' ? '✗' : seg.color === 'yellow' ? '⚠' : '·';
        console.log(`  ${mark} [${seg.risk}] ${seg.text}${seg.matchedRule ? ` (${seg.matchedRule})` : ''}`);
      }
    } else if (r.kind === 'policy') {
      console.log(`\n⚠ ${prefix} 需要批准: ${call.name} — ${r.detail} [${r.ruleId}]`);
    } else {
      console.log(`\n⚠ ${prefix} 需要批准: ${call.name} — ${r.note}`);
    }
  };

  // 子智能体审批冒泡：经宿主通道送达，复用同一审批卡片与交互（§12.7）。
  engine.setHostEventSink((ev) => {
    if (ev.type === 'subagent.approval.required') {
      void presentApproval(`[子智能体 ${ev.agentType}]`, ev.call, ev.reason).then(async () => {
        const ans = (await ask('  批准? [y/N] ')).trim().toLowerCase();
        engine.resolveApproval(sid, ev.callId, ans.startsWith('y') ? 'allow' : 'deny');
      });
      return;
    }
    renderEvent(ev);
  });

  const runUndo = (): void => {
    const snapshotDir = path.join(process.cwd(), '.mozi', 'snapshots', sid);
    if (!listSnapshots(snapshotDir).length) {
      console.log('无可撤销的修改。');
      return;
    }
    const restored = undoLast(
      snapshotDir,
      (p, content) => fs.writeFileSync(path.resolve(p), content, 'utf-8'),
      (p) => fs.rmSync(path.resolve(p), { force: true }),
    );
    if (restored?.length) {
      console.log(`已撤销 ${restored.length} 个文件的修改：\n${restored.map((p) => `  ${p}`).join('\n')}`);
    } else {
      console.log('无可撤销的修改。');
    }
  };

  while (true) {
    const line = (await ask('\n> ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    if (line === '/undo') {
      runUndo();
      continue;
    }

    const events = engine.run({ sessionId: sid, text: line });
    for await (const ev of events) {
      if (ev.type === 'tool.approval.required') {
        await presentApproval('', ev.call, ev.reason);
        const ans = (await ask('批准? [y/N] ')).trim().toLowerCase();
        engine.resolveApproval(sid, ev.call.id, ans.startsWith('y') ? 'allow' : 'deny');
      } else {
        renderEvent(ev);
      }
    }
  }
  rl.close();
}

const program = new Command();
program
  .name('mozi')
  .description('Mozi（墨子）—— 开源编码 Agent。引擎可复用，多模型适配，事件开放。')
  .argument('[prompt...]', '任务描述；省略则进入交互 REPL')
  .option('--json', '以 NDJSON 输出事件流（非交互）')
  .option('--session <id>', '会话 ID（用于 resume）')
  .option('--policy-mode <mode>', '审批模式: readonly | auto | full-auto（task 子命令的 --policy 用于无人值守策略）', 'auto')
  .option('--yes', '非交互模式下自动批准所有需要审批的工具调用')
  .action(
    async (
      promptParts: string[],
      opts: { json?: boolean; session?: string; policyMode?: string; yes?: boolean },
    ) => {
      const prompt = promptParts.join(' ').trim();
      if (!prompt) {
        await runRepl();
        return;
      }
      const code = await runExec(prompt, { ...opts, policy: opts.policyMode });
      process.exit(code);
    },
  );

program
  .command('sessions')
  .description('列出本地会话')
  .action(() => {
    const store = new SessionStore(SESSION_DIR);
    const list = store.list();
    if (!list.length) {
      console.log('（无会话）');
      return;
    }
    for (const s of list) {
      console.log(`${s.id}  model=${s.model ?? '-'}  updated=${s.updatedAt ?? '-'}`);
    }
  });

// ── M4.5：定时任务子命令族（M13 §13.9）──
registerTaskCommands(program);

// ── M4.75：远程访问（serve + device 管理，M14 §14.11）──
program
  .command('serve')
  .description('启动远程服务（headless；真实 WSS 需 ws 依赖）')
  .option('--port <n>', '监听端口', '7777')
  .option('--lan', '仅局域网直连')
  .option('--relay <url>', '经自托管中继')
  .action((opts) => {
    void serve({ port: Number(opts.port), lan: opts.lan, relay: opts.relay });
  });
registerRemoteCommands(program);

void program.parseAsync(process.argv);
