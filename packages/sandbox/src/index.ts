/**
 * @mozi/sandbox —— 四档隔离沙箱（M6 §6.4）。
 * 对外暴露：选择链 createSandbox、平台探测、网络白名单、底层执行器、KILLED 哨兵。
 */
export const PKG = '@mozi/sandbox';

export { createSandbox, previewLevel, type SandboxConfig, KILLED_EXIT_CODE } from './select.js';
export {
  detectSandboxSupport,
  hasCommand,
  isWindows,
  type Platform,
  type SandboxSupport,
} from './platform.js';
export {
  isNetworkAllowed,
  mergeAllowNet,
  defaultAllowNet,
} from './network.js';
export {
  execL0,
  execL1,
  execL2,
  execL3,
  isDirWritable,
} from './exec.js';
