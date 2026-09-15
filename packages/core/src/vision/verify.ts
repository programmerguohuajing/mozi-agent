/**
 * M17 §17.4：定时任务截图验证步骤（M13 联动）。
 *
 * TaskRunConfig 新增可选步骤（在 prompt 之后执行）：
 *   执行：截图 → vision 模型对比 expectation（结构化判定）→ 报告附截图与判定。
 *   任务配置校验：executor 模型必须 vision-capable，否则创建时拒绝。
 */
export interface VerifyStep {
  kind: 'screenshot';
  /** 待验证页面。 */
  url: string;
  /** 自然语言预期：「登录表单居中且无报错弹窗」。 */
  expectation: string;
  /** 结果写入报告；mismatch 可选置为任务失败。 */
  failIf?: 'mismatch';
}

/** 结构化判定结果。 */
export interface VerifyVerdict {
  verdict: 'pass' | 'fail' | 'unclear';
  evidence: string;
  /** 截图落盘路径与 contentId（报告附截图）。 */
  screenshot?: { path: string; contentId: string };
}

/** 任务校验：截图验证步骤要求 executor 为 vision-capable（§17.4）。 */
export function validateVerifyStep(
  step: VerifyStep | undefined,
  executorVisionCapable: boolean,
): { ok: true } | { ok: false; error: string } {
  if (!step) return { ok: true };
  if (step.kind !== 'screenshot')
    return { ok: false, error: `未知的验证步骤类型：${String(step.kind)}` };
  if (!step.url) return { ok: false, error: '截图验证步骤缺少 url' };
  if (!step.expectation) return { ok: false, error: '截图验证步骤缺少 expectation' };
  if (!executorVisionCapable) {
    return {
      ok: false,
      error:
        '该任务包含截图验证步骤，executor 模型必须支持视觉（vision-capable），请更换模型后重试。',
    };
  }
  return { ok: true };
}
