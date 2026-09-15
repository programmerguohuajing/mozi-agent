/**
 * PatchEngine 测试：parser / matcher / applier / edit_file 三明治测试 + fuzz（M3 §3.7）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileTool } from '../edit-file.js';
import { applyPatch } from '../patch-applier.js';
import { applyLocations, matchFile } from '../patch-matcher.js';
import { parsePatch } from '../patch-parser.js';
import type { ToolContext } from '../types.js';
import { Workspace } from '../workspace.js';

let dir: string;
let ws: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mozi-patch-'));
  ws = new Workspace(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  ws.writeFile(path, content);
}

function makeCtx(): ToolContext {
  return { workspace: ws, signal: new AbortController().signal, sessionId: 'test-session' };
}

// ── Parser ──────────────────────────────────────────────────────

describe('parsePatch', () => {
  it('解析 Update 文件的 hunk（context/-/+）', () => {
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 3;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(patch.files).toHaveLength(1);
    const f = patch.files[0]!;
    expect(f.op).toBe('update');
    expect(f.path).toBe('a.ts');
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks?.[0]!;
    expect(h.signature).toEqual(['const x = 1;', 'const y = 2;']);
    expect(h.additions).toEqual(['const y = 3;']);
  });

  it('解析 Add / Delete 操作', () => {
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Add File: new.ts',
        '+export const a = 1;',
        '+export const b = 2;',
        '*** Delete File: old.ts',
        '*** End Patch',
      ].join('\n'),
    );
    expect(patch.files).toHaveLength(2);
    expect(patch.files[0]?.op).toBe('add');
    expect(patch.files[0]?.body).toEqual(['export const a = 1;', 'export const b = 2;']);
    expect(patch.files[1]?.op).toBe('delete');
  });

  it('一个 patch 包含多个文件操作', () => {
    const patch = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '-old',
        '+new',
        '*** Add File: b.ts',
        '+b content',
        '*** Delete File: c.ts',
        '*** End Patch',
      ].join('\n'),
    );
    expect(patch.files.map((f) => f.op)).toEqual(['update', 'add', 'delete']);
  });

  it('缺少 End 标记 → ERR_PATCH_PARSE', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Add File: x.ts\n+hi')).toThrowError(/End Patch/);
  });

  it('缺少 Begin 标记 → ERR_PATCH_PARSE', () => {
    expect(() => parsePatch('*** Add File: x.ts\n+hi')).toThrowError(/Begin Patch/);
  });

  it('无文件操作 → ERR_PATCH_PARSE', () => {
    expect(() => parsePatch('*** Begin Patch\n*** End Patch')).toThrowError(/no file operations/);
  });

  it('超过 10 个文件 → ERR_PATCH_PARSE', () => {
    const lines = ['*** Begin Patch'];
    for (let i = 0; i < 11; i++) lines.push(`*** Add File: f${i}.ts`, '+x');
    lines.push('*** End Patch');
    expect(() => parsePatch(lines.join('\n'))).toThrowError(/10 files/);
  });
});

// ── Matcher ─────────────────────────────────────────────────────

describe('matchFile / applyLocations', () => {
  it('精确匹配并替换', () => {
    const content = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const result = matchFile('a.ts', content, [
      { signature: ['line2', 'line3'], additions: ['LINE2', 'LINE3'] },
    ]);
    if ('error' in result) throw new Error('should match');
    expect(result.locations[0]?.start).toBe(1);
    const out = applyLocations(
      content.split('\n'),
      [{ signature: ['line2', 'line3'], additions: ['LINE2', 'LINE3'] }],
      result.locations,
    );
    expect(out.join('\n')).toBe(['line1', 'LINE2', 'LINE3', 'line4'].join('\n'));
  });

  it('忽略行尾空白差异', () => {
    const content = 'line1  \nline2\t\n';
    const result = matchFile('a.ts', content, [
      { signature: ['line1', 'line2'], additions: ['x'] },
    ]);
    if ('error' in result) throw new Error('should match (trailing ws ignored)');
    expect(result.locations[0]?.start).toBe(0);
  });

  it('多个 hunk 依序匹配（后一 hunk 从前一尾部搜索）', () => {
    const content = ['a', 'b', 'c', 'b', 'c', 'd'].join('\n');
    const result = matchFile('a.ts', content, [
      { signature: ['b', 'c'], additions: ['B'] },
      { signature: ['b', 'c'], additions: ['B2'] },
    ]);
    if ('error' in result) throw new Error('should match');
    expect(result.locations[0]?.start).toBe(1);
    expect(result.locations[1]?.start).toBe(3);
  });

  it('不匹配 → 返回诊断（期望内容 + 最近行）', () => {
    const content = ['fn a() {}', 'const x = 1;'].join('\n');
    const result = matchFile('a.ts', content, [
      { signature: ['fn b() {}', '  return null;'], additions: [] },
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.expected).toContain('fn b() {}');
      expect(result.error.file).toBe('a.ts');
    }
  });
});

// ── Applier ─────────────────────────────────────────────────────

describe('applyPatch', () => {
  it('Update：替换后文件内容正确', () => {
    write('a.ts', 'const x = 1;\nconst y = 2;\n');
    const result = applyPatch(
      parsePatch(
        [
          '*** Begin Patch',
          '*** Update File: a.ts',
          '-const y = 2;',
          '+const y = 3;',
          '*** End Patch',
        ].join('\n'),
      ),
      ws,
    );
    expect(ws.readFile('a.ts')).toBe('const x = 1;\nconst y = 3;\n');
    expect(result.before['a.ts']).toContain('const y = 2;');
    expect(result.after['a.ts']).toContain('const y = 3;');
  });

  it('Add：新文件写入（含父目录）', () => {
    applyPatch(
      parsePatch(
        [
          '*** Begin Patch',
          '*** Add File: src/deep/new.ts',
          '+export const q = 1;',
          '*** End Patch',
        ].join('\n'),
      ),
      ws,
    );
    expect(ws.readFile('src/deep/new.ts')).toBe('export const q = 1;');
  });

  it('Add 已存在的文件 → 报错且不写入', () => {
    write('exists.ts', 'x');
    expect(() =>
      applyPatch(
        parsePatch(
          ['*** Begin Patch', '*** Add File: exists.ts', '+y', '*** End Patch'].join('\n'),
        ),
        ws,
      ),
    ).toThrowError(/already exists/);
    expect(ws.readFile('exists.ts')).toBe('x');
  });

  it('Delete：文件被删除', () => {
    write('gone.ts', 'bye');
    applyPatch(
      parsePatch(['*** Begin Patch', '*** Delete File: gone.ts', '*** End Patch'].join('\n')),
      ws,
    );
    expect(ws.readFile('gone.ts')).toBeNull();
  });

  it('Delete 不存在的文件 → ERR_FILE_NOT_FOUND', () => {
    expect(() =>
      applyPatch(
        parsePatch(['*** Begin Patch', '*** Delete File: nope.ts', '*** End Patch'].join('\n')),
        ws,
      ),
    ).toThrowError(/not found/);
  });

  it('原子性：第二个文件 hunk 失败 → 第一个文件不被修改', () => {
    write('a.ts', 'aaa\n');
    write('b.ts', 'bbb\n');
    expect(() =>
      applyPatch(
        parsePatch(
          [
            '*** Begin Patch',
            '*** Update File: a.ts',
            '-aaa',
            '-AAA',
            '*** Update File: b.ts',
            '-WRONG ANCHOR THAT DOES NOT EXIST',
            '+x',
            '*** End Patch',
          ].join('\n'),
        ),
        ws,
      ),
    ).toThrowError(/WRONG ANCHOR|Mismatch/);
    // a.ts 必须保持原样（事务拒绝，不部分应用）
    expect(ws.readFile('a.ts')).toBe('aaa\n');
  });

  it('快照落盘：snapshotDir 提供时写入备份文件', () => {
    write('a.ts', 'v1\n');
    const snapDir = join(dir, '.mozi', 'snapshots');
    applyPatch(
      parsePatch(
        ['*** Begin Patch', '*** Update File: a.ts', '-v1', '+v2', '*** End Patch'].join('\n'),
      ),
      ws,
      snapDir,
    );
    expect(existsSync(snapDir)).toBe(true);
    const files = require('node:fs').readdirSync(snapDir) as string[];
    expect(files.length).toBe(1);
    const snapContent = readFileSync(join(snapDir, files[0]!), 'utf-8');
    expect(snapContent).toBe('v1\n');
  });
});

// ── edit_file 工具（三明治：输入 → 临时工作区 → 断言文件系统） ──

describe('edit_file tool', () => {
  it('成功应用 patch 并返回 diff display', async () => {
    write('a.ts', 'one\ntwo\n');
    const ctx = makeCtx();
    const result = await editFileTool.execute(
      {
        patch: ['*** Begin Patch', '*** Update File: a.ts', '-two', '+TWO', '*** End Patch'].join(
          '\n',
        ),
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(ws.readFile('a.ts')).toBe('one\nTWO\n');
    expect(result.display?.kind).toBe('diff');
    if (result.display?.kind === 'diff') {
      expect(result.display.file).toBe('a.ts');
      expect(result.display.hunks).toBe(1);
    }
  });

  it('解析失败 → isError + ERR_PATCH_PARSE', async () => {
    const result = await editFileTool.execute({ patch: 'not a patch' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.meta?.errorKind).toBe('ERR_PATCH_PARSE');
  });

  it('匹配失败 → ERR_PATCH_MISMATCH', async () => {
    write('a.ts', 'real content\n');
    const result = await editFileTool.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.ts',
          '-no such line',
          '+x',
          '*** End Patch',
        ].join('\n'),
      },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.meta?.errorKind).toBe('ERR_PATCH_MISMATCH');
  });
});

// ── Fuzz：随机代码 → 随机变更 → 生成 patch → 断言等价（M3 §3.7） ──

describe('fuzz', () => {
  // 简单可复现的伪随机
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  it('随机行删除/修改/插入通过 patch 应用后结果一致（200 轮）', () => {
    for (let round = 0; round < 200; round++) {
      // 生成随机“代码”文件
      const lineCount = 5 + rand(30);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        lines.push(`line ${i} ${['alpha', 'beta', 'gamma', 'delta'][rand(4)]} ${rand(100)}`);
      }
      const original = lines.join('\n');

      // 随机选 1-3 处变更（按行号排序：hunk 必须依序出现，与真实 patch 一致）
      const hunks: Array<{ sig: string[]; adds: string[] }> = [];
      const used = new Set<number>();
      const changeCount = 1 + rand(3);
      const idxs: number[] = [];
      for (let c = 0; c < changeCount; c++) {
        const idx = rand(lineCount);
        if (used.has(idx)) continue;
        used.add(idx);
        idxs.push(idx);
      }
      idxs.sort((a, b) => a - b);
      for (const idx of idxs) {
        const op = rand(3); // 0=修改 1=删除 2=插入
        const sig = [lines[idx]!];
        let adds: string[];
        if (op === 0) {
          adds = [`changed ${idx} v${round}`];
        } else if (op === 1) {
          adds = [];
        } else {
          adds = [`inserted before ${idx}`, lines[idx]!];
        }
        hunks.push({ sig, adds });
      }
      if (hunks.length === 0) continue;

      // 构造 patch 文本（hunk 之间以空行分隔，符合语法规范）
      const patchLines = ['*** Begin Patch', '*** Update File: f.txt'];
      hunks.forEach((h, hIdx) => {
        if (hIdx > 0) patchLines.push('');
        for (const s of h.sig) patchLines.push(`-${s}`);
        for (const a of h.adds) patchLines.push(`+${a}`);
      });
      patchLines.push('*** End Patch');

      // 手工计算期望结果（与 PatchEngine 独立的推导）
      const expected: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const hunk = hunks.find((h) => h.sig[0] === lines[i]);
        if (hunk) {
          expected.push(...hunk.adds);
        } else {
          expected.push(lines[i]!);
        }
      }

      // 应用并断言
      write('f.txt', original);
      applyPatch(parsePatch(patchLines.join('\n')), ws);
      const actual = ws.readFile('f.txt') ?? '';
      expect(actual.split('\n')).toEqual(expected);
    }
  });
});
