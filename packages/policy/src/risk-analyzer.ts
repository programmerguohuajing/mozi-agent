/**
 * 命令风险分析器 RiskAnalyzer（M6 §6.2）。
 * 把 shell 命令拆成子命令段（&& || ; | 分隔），逐段评级：
 *   safe（白名单只读） | side-effect（写操作） | network（网络访问） | high（高危/解释器执行）。
 * 综合风险 = max(各段)；管道链 curl|sh 识别为 high。
 * 设计原则：不追求完备（防绕过靠沙箱兜底），只负责把「值得人类看」的命令拆清楚。
 */
import type { CommandSegment } from '@mozi/shared';

export type CommandRisk = CommandSegment['risk'];

const RISK_ORDER: Record<CommandRisk, number> = {
  safe: 0,
  'side-effect': 1,
  network: 2,
  high: 3,
};

/** 只读白名单：这些命令（不带写参数）视为 safe。 */
const SAFE_COMMANDS = new Set([
  // 文件查看
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'find', 'tree', 'du', 'df',
  // 文本搜索/处理（只读用法）
  'grep', 'rg', 'awk', 'sed', 'cut', 'sort', 'uniq', 'diff', 'comm', 'jq',
  // 开发工具查询类
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'python', 'python3', 'cargo', 'go',
  'echo', 'printf', 'pwd', 'which', 'whereis', 'whoami', 'date', 'env', 'printenv', 'uname', 'hostname',
  'type', 'help', 'man', 'true', 'false', 'test', 'expr', 'bc',
]);

/** 写操作命令。 */
const SIDE_EFFECT_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'tee', 'chmod', 'chown', 'chgrp', 'ln', 'touch',
  'mkdir', 'truncate', 'install', 'rsync', 'strip', 'patch',
]);

/** 网络访问命令。 */
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'ping', 'nslookup', 'dig',
  'git', 'npm', 'npx', 'pnpm', 'yarn',
]);

/** 高危命令/模式：解释器执行、磁盘操作、权限提升等。 */
const HIGH_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'eval', 'exec', 'source', '.',
  'dd', 'mkfs', 'mkfs.ext4', 'fdisk', 'parted', 'sudo', 'su', 'doas',
  'base64', 'openssl', 'nc', 'kill', 'killall', 'pkill',
]);

/** 命令 → 风险上下文的例外：git/npm 等两用命令按子命令细分。 */
const GIT_SUB: Record<string, CommandRisk> = {
  status: 'safe', log: 'safe', diff: 'safe', show: 'safe', branch: 'safe',
  add: 'side-effect', commit: 'side-effect', checkout: 'side-effect', restore: 'side-effect',
  stash: 'side-effect', merge: 'side-effect', rebase: 'side-effect', cherry: 'side-effect',
  reset: 'side-effect', clean: 'side-effect', revert: 'side-effect', tag: 'side-effect',
  push: 'side-effect', pull: 'side-effect', fetch: 'network', clone: 'network',
};

const NPM_SUB: Record<string, CommandRisk> = {
  test: 'safe', run: 'safe', ci: 'safe', exec: 'safe',
  install: 'network', i: 'network', add: 'network', update: 'network', publish: 'side-effect',
  remove: 'side-effect', uninstall: 'side-effect', uninstallAll: 'side-effect',
};

/** 从 argv[0] 提取主命令名（去路径前缀，Windows 反斜杠同样处理）。 */
function baseName(arg0: string): string {
  const last = arg0.split(/[\\/]/).pop() ?? arg0;
  return last.replace(/\.(exe|cmd|bat|sh)$/i, '').toLowerCase();
}

/** 单段命令的 argv 解析（引号感知的轻 tokenizer，处理注释）。 */
export function tokenizeSegment(segment: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  let inComment = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (inComment) break;
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasToken = true;
      continue;
    }
    if (c === '\\' && i + 1 < segment.length) {
      cur += segment[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (c === '#' && !hasToken) {
      inComment = true;
      break;
    }
    if (c === ' ' || c === '\t') {
      if (hasToken) argv.push(cur);
      cur = '';
      hasToken = false;
      continue;
    }
    cur += c;
    hasToken = true;
  }
  if (inComment) return argv.length ? argv : []; // 注释后的内容全部忽略
  if (hasToken) argv.push(cur);
  return argv;
}

/** 拆出段内的变量赋值前缀（FOO=bar cmd ...），返回剥掉赋值后的 argv。 */
function stripEnvAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? '')) i++;
  return argv.slice(i);
}

/** 单段评级。 */
export function rateSegment(argvRaw: string[]): { argv: string[]; risk: CommandRisk; matchedRule?: string } {
  const argv = stripEnvAssignments(argvRaw);
  const cmd0 = argv[0];
  if (!cmd0) return { argv: [], risk: 'safe' };
  const cmd = baseName(cmd0);
  const rest = argv.slice(1);

  // 危险重定向：> /dev/sd*、覆盖式写入设备文件
  const joined = argv.join(' ');
  if (/>\s*\/dev\/(sd|nvme|disk)/.test(joined)) {
    return { argv, risk: 'high', matchedRule: 'X_redirect_device' };
  }

  if (HIGH_COMMANDS.has(cmd)) {
    return { argv, risk: 'high', matchedRule: 'X_high_command' };
  }
  // sh/bash -c "..." 之外的参数形式同样高危；解释器已全部在 HIGH_COMMANDS
  if (cmd === 'base64' && rest.some((a) => a === '-d' || a === '-D' || a === '--decode')) {
    return { argv, risk: 'high', matchedRule: 'X_base64_decode' };
  }

  // 网络类（细分 git/npm 子命令）
  if (cmd === 'git') {
    const sub = rest[0]?.toLowerCase() ?? '';
    const risk = GIT_SUB[sub] ?? 'safe';
    return { argv, risk, matchedRule: risk === 'safe' ? undefined : `X_git_${sub}` };
  }
  if (cmd === 'npm' || cmd === 'npx' || cmd === 'pnpm' || cmd === 'yarn') {
    const sub = rest[0]?.toLowerCase() ?? '';
    const risk = NPM_SUB[sub] ?? 'safe';
    return { argv, risk, matchedRule: risk === 'safe' ? undefined : `X_pkg_${sub}` };
  }
  if (NETWORK_COMMANDS.has(cmd)) {
    return { argv, risk: 'network', matchedRule: 'X_network' };
  }
  if (SIDE_EFFECT_COMMANDS.has(cmd)) {
    return { argv, risk: 'side-effect', matchedRule: 'X_side_effect' };
  }
  if (SAFE_COMMANDS.has(cmd)) {
    return { argv, risk: 'safe' };
  }
  // 未知命令：不猜测，标为 side-effect 提请人注意
  return { argv, risk: 'side-effect', matchedRule: 'X_unknown_command' };
}

/**
 * 命令 → 结构化风险明细。
 * 输出各段（保留管道/逻辑分隔语义）+ 综合风险（max）。
 */
export function analyzeCommand(command: string): { segments: CommandSegment[]; overall: CommandRisk } {
  const segments: CommandSegment[] = [];

  // 一级拆分：; && || （顺序执行/逻辑链）；二级拆分：| 管道（保留原文本，段内合并评级）
  const topParts = splitTopLevel(command, ['&&', '||', ';']);

  for (const part of topParts) {
    const trimmed = part.text.trim();
    if (!trimmed) continue;

    const pipeParts = splitTopLevel(trimmed, ['|']);
    if (pipeParts.length > 1) {
      // 管道链：curl ... | sh 是经典绕过 → high
      const rated = pipeParts.map((pp) => rateSegment(tokenizeSegment(pp.text)));
      let risk: CommandRisk = 'safe';
      for (const r of rated) {
        if (RISK_ORDER[r.risk] > RISK_ORDER[risk]) risk = r.risk;
      }
      // 管道末段是解释器（| sh、| bash、| sh -）→ 直接 high
      const lastArgv = rated[rated.length - 1]?.argv ?? [];
      const lastCmd = lastArgv[0] ? baseName(lastArgv[0]) : '';
      if (lastCmd === 'sh' || lastCmd === 'bash' || lastCmd === 'zsh') {
        risk = 'high';
      }
      segments.push({
        text: trimmed,
        argv: rated.flatMap((r) => r.argv),
        risk: risk === 'safe' ? 'safe' : risk,
        matchedRule: pipeParts.length > 2 ? 'X_pipe_chain' : undefined,
        color: colorOf(risk),
      });
      continue;
    }

    const { argv, risk, matchedRule } = rateSegment(tokenizeSegment(trimmed));
    segments.push({ text: trimmed, argv, risk, matchedRule, color: colorOf(risk) });
  }

  let overall: CommandRisk = 'safe';
  for (const s of segments) {
    if (RISK_ORDER[s.risk] > RISK_ORDER[overall]) overall = s.risk;
  }
  return { segments, overall };
}

/** 综合风险 → 审批建议。 */
export function riskToApproval(risk: CommandRisk): 'allow' | 'ask' | 'deny' {
  switch (risk) {
    case 'safe':
      return 'allow';
    case 'side-effect':
    case 'network':
      return 'ask';
    case 'high':
      return 'deny';
  }
}

function colorOf(risk: CommandRisk): CommandSegment['color'] {
  if (risk === 'safe') return 'green';
  if (risk === 'high') return 'red';
  return 'yellow';
}

/** 按顶层分隔符拆分（不进入引号内部）。返回段与其前导分隔符。 */
function splitTopLevel(
  command: string,
  seps: string[],
): Array<{ text: string; sep: string }> {
  const parts: Array<{ text: string; sep: string }> = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[i + 1];
      i += 2;
      continue;
    }
    const rest = command.slice(i);
    const hit = seps.find((s) => rest.startsWith(s));
    if (hit) {
      parts.push({ text: cur, sep: hit });
      cur = '';
      i += hit.length;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push({ text: cur, sep: '' });
  return parts;
}
