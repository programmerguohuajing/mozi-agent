/** M15 提示词系统工程（Prompt System）。 */
export {
  PromptAssembler,
  PROMPT_BUDGET_TOKENS,
  estimatePromptTokens,
  expandCapabilities,
} from './assembler.js';
export type {
  PromptBuildInput,
  PromptBuildResult,
  PromptEnvironment,
} from './assembler.js';
export { PromptAssets, CAPABILITY_FILES, POLICY_FILES } from './assets.js';
