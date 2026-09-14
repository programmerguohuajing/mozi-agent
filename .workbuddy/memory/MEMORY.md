# Mozi（墨子）项目长期记忆

## 仓库与构建（务必遵守）
- pnpm + turbo + TypeScript（NodeNext + project references + composite）monorepo，位于 `D:/codex/mozi`。
- **绝不要跑 `tsc -b tsconfig.base.json`**：base 仅供 extends、无 outDir，会污染源码目录（曾把 .js/.d.ts 吐到 288 个源文件旁）。
  正确做法：**逐包** `tsc -b packages/<pkg>/tsconfig.json`（重定向输出到文件再读）。
- 本机未跑 `pnpm install`：`node_modules/@mozi/*` 靠手工 junction symlink 解析；类型解析靠各 package tsconfig 的 `baseUrl` + `paths` 指向 `../<pkg>/dist/index.d.ts`。
- tsconfig.base 开启 `strict` / `noUncheckedIndexedAccess` / `noImplicitOverride` / `verbatimModuleSyntax`：`args[0]`、`tools[0]` 需 `!` 或 `?.`。
- 构建用绝对路径 node：`C:/Users/A/.workbuddy/binaries/node/versions/22.22.2-3/node.exe` + `node_modules/.pnpm/typescript@5.9.3/.../tsc.js`。
- 环境：bash 的 coreutils（dirname/head/cat/rm）时好时坏；**PowerShell 最可靠**，写 UTF-8 用 `[System.IO.File]::WriteAllText`。Windows 下 node ESM 脚本导入本地文件需 `file:///` URL。
- 无 pnpm 环境跑运行时验证：用独立 node ESM 脚本（`_tmp_*.mjs`）+ 回环 transport，替代 vitest 交互测试；跑完清理临时文件。

## 类型归属（容易搞错）
- `JSONSchema` → `@mozi/tools`
- `ChatMessage` / `ToolResult` / `RunInput` / events → `@mozi/shared`
- `ChatRequest` → `@mozi/providers`

## 关键架构决策
- **子智能体审批冒泡走"宿主实时通道"**：父 `run()` 生成器会阻塞在 `executeOne → tool.execute → supervisor`，子智能体事件无法经父 yield 流送出。因此 `AgentEngine` 提供 `setHostEventSink(onEvent)` / `emitLive(event, originSessionId?)`，子事件绕开生成器直打宿主 sink；factory 暴露 `onEvent` 选项。**supervisor 只 emit、不 appendEvent**（事件唯一来源是 engine.log，否则重复）。
- 子智能体 = 又一次 `AgentEngine.run()`（Supervisor 模式），策略 `child = min(parent, template)`，工具取交集；子会话落 `subs/<id>/events.jsonl`。
- 审批网关 `InteractiveApprovalGateway` 需 `early` map：sink 可能在 `approval.request` 注册前同步触发（竞态）。
- Auto-Compact 的 `turnsSinceLastCompact` 初值用 `-1` 哨兵（"从未压缩"），`shouldCompact` 需 `>= 0` 才拦 min-interval，否则首轮永远压不了。

## 打包 / 运行期资源（踩过坑）
- **非代码资源不会被自动复制**：`packages/core/src/prompts/**.md` 是 `PromptAssets` 的运行期真源，tsc / esbuild 都只处理代码。必须在三处显式复制：core 的 `build` 脚本调 `scripts/copy-prompts.mjs` → `core/dist/prompts`；`desktop/scripts/bundle.mjs` 的 `copyPromptAssets()` → `desktop/dist/prompts`；`package.mjs` 的 `copies` 与 asar `files` 白名单加 `dist/prompts/**/*`。漏任一处，打包后一发消息就报 `ERR_TOOL_INTERNAL: prompts 目录未找到（identity.md 缺失）`。
- **esbuild `format:'cjs'` 下 `import.meta` 为空对象**（有明确 WARNING）。任何"自定位模块目录"的加载器必须**优先 `__dirname`**，再退化 `import.meta.url`，且**每个候选独立 try/catch** —— 用一个外层 try 包住全部会把 TypeError 吞掉、候选列表变空。
- **esbuild 默认 `charset:'ascii'`**：产物里中文变成 `\uXXXX` 转义，用原文正则 grep 产物会误判"不存在"。
- `desktop/scripts/package.mjs` 的 `cleanReleaseDir()` 与宿主 safe-delete 守卫冲突（rmSync 与 renameSync 双失败即抛错）。**逃生门：`MOZI_RELEASE_DIR` 指向不存在的全新目录**，该函数直接 return。
- `packages/desktop/release/**/app.asar` 被外部句柄占用时**可原地覆盖、不可删除**（EBUSY/EPERM）；落产物用 `copyFileSync` 覆盖而非 move/delete。

## 交付节奏 / 用户偏好
- 全程不暂停推进：按 `docs/开发任务.md` 端到端执行整批任务，不在 capability 之间设人工 checkpoint。
- 每次代码改完直接 commit + push；跨会话要能清晰复述上一轮的问题与决策。
- 里程碑完成后同步更新 `docs/开发任务.md` 的章节与里程碑状态行。
