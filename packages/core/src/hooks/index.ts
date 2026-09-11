/** M18 Hooks 与生命周期插件。 */
export * from './types.js';
export {
  loadHooks,
  approveProjectHooks,
  readApproval,
  fingerprintFile,
  projectHooksPath,
  projectApprovalPath,
  USER_HOOKS_PATH,
  type LoadHooksOptions,
  type LoadResult,
} from './config.js';
export {
  HookRunner,
  extractNote,
  globMatch,
  type HookPayload,
  type HookRunnerOptions,
} from './runner.js';
