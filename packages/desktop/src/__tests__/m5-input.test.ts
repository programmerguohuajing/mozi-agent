import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentService,
  buildTextWithMentions,
  detectMention,
  extractMentions,
  insertMention,
  joinPath,
  listSkills,
  scanSkillDir,
} from '@mozi/desktop';
import { LoopbackChannel } from '@mozi/protocol';
import { ProviderRegistry, ScriptedProvider } from '@mozi/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * M5 输入栏能力测试：
 *   - 新建任务不再弹文件夹（workspaceRoot 可省略）
 *   - session:setWorkspace：切换项目文件夹 / 运行中拒绝 / meta.json 持久化
 *   - workspace:listEntries：@ 引用的目录浏览 + 递归搜索 + 噪声目录过滤
 *   - skills 扫描：~/.mozi/skills + 项目 .mozi/skills（SKILL.md frontmatter）
 *   - @ mention 纯函数：检测 / 插入 / 发送展开
 */

function makeRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(new ScriptedProvider([], 'scripted', 'scripted-model', {}));
  return reg;
}

let dir: string;
let sessionDir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-m5-'));
  sessionDir = path.join(dir, 'sessions');
  workspace = path.join(dir, 'ws');
  // setWorkspace 校验目录存在，提前创建。
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('新建任务：workspaceRoot 可省略（不再先弹文件夹）', () => {
  it('create({}) 使用用户主目录作为默认 workspace', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({});
    expect(s.workspace).toBe(os.homedir());
    // meta.json 记录真实 workspace（修复 core writeMeta 硬编码 cwd 的问题）
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, s.id, 'meta.json'), 'utf8'));
    expect(meta.workspace).toBe(os.homedir());
    service.list(); // 覆盖 list 分支
    await service.shutdown();
  });

  it('显式 workspaceRoot 仍然生效并写入 meta.json', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    expect(s.workspace).toBe(workspace);
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, s.id, 'meta.json'), 'utf8'));
    expect(meta.workspace).toBe(workspace);
    await service.shutdown();
  });
});

describe('session:setWorkspace：输入栏「+」→ 选择项目文件夹', () => {
  it('切换 workspace：引擎重建 + list() 反映新目录 + meta.json 更新', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const target = path.join(dir, 'target-ws');
    fs.mkdirSync(target, { recursive: true });
    const r = await service.setWorkspace(s.id, target);
    expect(r.ok).toBe(true);
    expect(r.summary?.workspace).toBe(target);
    const item = service.list().find((x) => x.id === s.id)!;
    expect(item.workspace).toBe(target);
    expect(item.project).toBe('target-ws');
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, s.id, 'meta.json'), 'utf8'));
    expect(meta.workspace).toBe(target);
    await service.shutdown();
  });

  it('目录不存在 / 不是目录 → 拒绝且原引擎不受影响', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const bad = await service.setWorkspace(s.id, path.join(dir, 'no-such-dir'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    // workspace 未变
    expect(service.workspaceOf(s.id)).toBe(workspace);
    await service.shutdown();
  });

  it('设置相同目录 → 幂等成功（不重建引擎）', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const r = await service.setWorkspace(s.id, workspace);
    expect(r.ok).toBe(true);
    expect(service.workspaceOf(s.id)).toBe(workspace);
    await service.shutdown();
  });
});

describe('workspace:listEntries：@ 引用弹层数据源', () => {
  beforeEach(() => {
    // 目录结构：
    //   ws/src/App.tsx, ws/src/components/Button.tsx
    //   ws/docs/readme.md
    //   ws/node_modules/pkg/index.js（噪声，应被过滤）
    //   ws/.git/config（隐藏，应被过滤）
    fs.mkdirSync(path.join(workspace, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'App.tsx'), 'x');
    fs.writeFileSync(path.join(workspace, 'src', 'components', 'Button.tsx'), 'x');
    fs.writeFileSync(path.join(workspace, 'docs', 'readme.md'), 'x');
    fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  });

  it('浏览模式：根目录条目（目录在前），过滤 node_modules / 隐藏目录', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const r = service.listEntries({ sessionId: s.id });
    expect(r.ok).toBe(true);
    expect(r.workspaceRoot).toBe(workspace);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('docs');
    expect(names).toContain('package.json');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    // 目录排在文件前
    expect(r.entries[0]?.isDir).toBe(true);
    await service.shutdown();
  });

  it('浏览模式：dir 子目录 + path 为 / 分隔的相对路径', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const r = service.listEntries({ sessionId: s.id, dir: 'src' });
    expect(r.ok).toBe(true);
    const paths = r.entries.map((e) => e.path);
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('src/components');
    await service.shutdown();
  });

  it('搜索模式：递归匹配文件名（query），跳过 node_modules', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const r = service.listEntries({ sessionId: s.id, query: 'app' });
    expect(r.ok).toBe(true);
    expect(r.entries.some((e) => e.path === 'src/App.tsx')).toBe(true);
    const js = service.listEntries({ sessionId: s.id, query: 'index.js' });
    expect(js.entries.some((e) => e.path.includes('node_modules'))).toBe(false);
    await service.shutdown();
  });

  it('路径越界（../ 逃逸）→ 拒绝', async () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    const r = service.listEntries({ sessionId: s.id, dir: '../..' });
    expect(r.ok).toBe(false);
    await service.shutdown();
  });

  it('未知会话 → 报错不崩溃', () => {
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const r = service.listEntries({ sessionId: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.entries).toEqual([]);
  });
});

describe('skills:list：本地技能扫描', () => {
  it('SKILL.md frontmatter 解析（name/description/icon）', () => {
    const skillsRoot = path.join(dir, 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, 'my-skill', 'SKILL.md'),
      '---\nname: 我的技能\ndescription: 做点什么\nicon: 🎯\nversion: 2.1.0\n---\n\n正文指令。',
    );
    const skills = scanSkillDir(skillsRoot, 'custom');
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('我的技能');
    expect(skills[0]?.description).toBe('做点什么');
    expect(skills[0]?.icon).toBe('🎯');
    expect(skills[0]?.version).toBe('2.1.0');
    expect(skills[0]?.category).toBe('custom');
    expect(skills[0]?.source).toContain('SKILL.md');
  });

  it('无 SKILL.md 的目录被跳过', () => {
    const skillsRoot = path.join(dir, 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'not-a-skill'), { recursive: true });
    expect(scanSkillDir(skillsRoot, 'custom')).toHaveLength(0);
  });

  it('listSkills：内置 + 项目技能合并，同名项目优先', () => {
    fs.mkdirSync(path.join(workspace, '.mozi', 'skills', 'code-review'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.mozi', 'skills', 'code-review', 'SKILL.md'),
      '---\nname: 代码审阅\ndescription: 项目级覆盖版本\n---\n正文',
    );
    const all = listSkills(workspace);
    expect(all.some((s) => s.category === 'builtin')).toBe(true);
    const cr = all.filter((s) => s.name === '代码审阅');
    expect(cr).toHaveLength(1);
    expect(cr[0]?.category).toBe('project');
    expect(cr[0]?.description).toBe('项目级覆盖版本');
  });
});

describe('@ mention 纯函数（shared/mentions.ts）', () => {
  it('detectMention：光标处 @ 检测（行首/空白后有效，邮箱无效）', () => {
    expect(detectMention('@', 1)).toEqual({ start: 0, query: '' });
    // '看看 @src/App' 长度 11，@ 在下标 3，光标 11 处 query='src/App'
    expect(detectMention('看看 @src/App', 11)).toEqual({ start: 3, query: 'src/App' });
    expect(detectMention('看看@src', 7)).toBeNull(); // @ 前是非空白 → 邮箱类
    expect(detectMention('a@b.com', 7)).toBeNull();
    expect(detectMention('文本', 2)).toBeNull();
  });

  it('insertMention：替换查询串为完整路径并加尾随空格', () => {
    // '看 @App 呀'：@ 在下标 2，光标 6（查询 'App' 尽头）；替换后 caret 紧随路径+尾空格。
    const r = insertMention('看 @App 呀', 6, 2, 'src/App.tsx');
    // slice(6)=' 呀'：原文光标后的空格保留，加上插入的尾随空格 → 两个空格
    expect(r.text).toBe('看 @src/App.tsx  呀');
    expect(r.caret).toBe(2 + 'src/App.tsx'.length + 2);
    // 弹层实际场景：查询未完（光标 5，'Ap'）→ 完整替换
    const r2 = insertMention('看 @Ap 呀', 5, 2, 'src');
    expect(r2.text).toBe('看 @src  呀');
  });

  it('extractMentions：提取去重 + 剥离尾部标点', () => {
    const text = '对比 @src/a.ts 和 @src/a.ts，再看 @docs/b.md。';
    const ms = extractMentions(text);
    expect(ms).toHaveLength(2);
    expect(ms[0]?.relPath).toBe('src/a.ts');
    expect(ms[1]?.relPath).toBe('docs/b.md');
  });

  it('extractMentions：中文文本紧贴路径（无空格分隔）也能正确剥离', () => {
    // '@docs/readme.md，然后汇报'：token 吸收中文后由 cleanToken 截断，得到 docs/readme.md
    const ms = extractMentions('请先看 @docs/readme.md，然后汇报');
    expect(ms).toHaveLength(1);
    expect(ms[0]?.relPath).toBe('docs/readme.md');
  });

  it('buildTextWithMentions：展开为绝对路径清单（含文件夹标注）', () => {
    const text = '请阅读 @src/App.tsx 与 @docs';
    const out = buildTextWithMentions(text, 'D:\\ws\\proj', (rel) =>
      rel === 'docs' ? true : undefined,
    );
    expect(out.startsWith(text)).toBe(true);
    expect(out).toContain('D:\\ws\\proj\\src\\App.tsx');
    expect(out).toContain('D:\\ws\\proj\\docs（文件夹）');
    // 无 mention 原样返回
    expect(buildTextWithMentions('普通文本', 'D:/w', () => undefined)).toBe('普通文本');
  });

  it('joinPath：Windows / POSIX 分隔符', () => {
    expect(joinPath('D:\\codex\\mozi', 'src/App.tsx')).toBe('D:\\codex\\mozi\\src\\App.tsx');
    expect(joinPath('/home/u/ws', 'src/App.tsx')).toBe('/home/u/ws/src/App.tsx');
    expect(joinPath('D:\\ws\\', 'a/b.ts')).toBe('D:\\ws\\a\\b.ts');
  });
});

describe('IpcBridge：新通道经 LoopbackChannel 可调用', () => {
  it('workspace:listEntries / skills:list / session:setWorkspace 全链路', async () => {
    const { IpcBridge } = await import('@mozi/desktop');
    const channel = new LoopbackChannel();
    const service = new AgentService({ sessionDir, providers: makeRegistry(), emit: () => {} });
    const s = await service.create({ workspaceRoot: workspace });
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'x');
    const { SettingsStore } = await import('@mozi/desktop');
    const { DiffReviewService, McpManager } = await import('@mozi/desktop');
    const bridge = new IpcBridge({
      service,
      settings: new SettingsStore({ filePath: path.join(dir, 'settings.json') }),
      diff: new DiffReviewService({ readFile: () => null, writeFile: () => {} }),
      mcp: new McpManager({
        connect: async () => ({ toolCount: 0 }),
        disconnect: async () => {},
        persist: () => {},
      }),
      channel,
    });
    bridge.install();

    const entries = (await channel.invoke('workspace:listEntries', { sessionId: s.id })) as {
      ok: boolean;
      entries: Array<{ path: string }>;
    };
    expect(entries.ok).toBe(true);
    expect(entries.entries.some((e) => e.path === 'src')).toBe(true);

    const skills = (await channel.invoke('skills:list', { sessionId: s.id })) as Array<{
      id: string;
    }>;
    expect(skills.some((x) => x.id === 'code-review')).toBe(true);

    const target = path.join(dir, 'new-ws');
    fs.mkdirSync(target, { recursive: true });
    const set = (await channel.invoke('session:setWorkspace', {
      sessionId: s.id,
      workspaceRoot: target,
    })) as { ok: boolean; summary?: { workspace?: string } };
    expect(set.ok).toBe(true);
    expect(set.summary?.workspace).toBe(target);
    await service.shutdown();
  });
});
