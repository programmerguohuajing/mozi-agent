/**
 * ToolRegistry：注册 / 查询 / 导出 schema / 安全分组调度（M3 §3.2）。
 */
import type { ToolCall } from '@mozi/shared';
import { editFileTool } from './edit-file.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readFileTool } from './read.js';
import { shellTool } from './shell.js';
import { taskTool } from './task.js';
import { todoListTool } from './todo-list.js';
import type { AgentTool, ToolContext } from './types.js';
import { toolSchema } from './types.js';
import { writeFileTool } from './write.js';

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(...ts: AgentTool[]): this {
    for (const t of ts) {
      if (this.tools.has(t.name)) {
        throw new Error(`tool already registered: ${t.name}`);
      }
      this.tools.set(t.name, t);
    }
    return this;
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 模型可见的 schemas（provider 层再按需裁剪 description 长度）。 */
  schemas(): Array<{ name: string; description: string; parameters: unknown }> {
    return [...this.tools.values()].map(toolSchema);
  }

  /**
   * 按 riskLevel 贪心分组：连续的 read / meta 归并为一组（可并行），
   * write/exec 各自成组（串行）。引擎据此「读并行 / 写串行」调度。
   * task 工具为 meta 级：按并发槽（Supervisor 内）控流，可与其他只读/派发并行（M12 §12.5）。
   */
  groupBySafety(calls: ToolCall[]): ToolCall[][] {
    const groups: ToolCall[][] = [];
    let parallel: ToolCall[] = [];
    for (const c of calls) {
      if (c.riskLevel === 'read' || c.riskLevel === 'meta') {
        parallel.push(c);
        continue;
      }
      if (parallel.length) {
        groups.push(parallel);
        parallel = [];
      }
      groups.push([c]);
    }
    if (parallel.length) groups.push(parallel);
    return groups;
  }
}

/** M1+M2 内置工具集：read_file / write_file / edit_file / glob / grep / shell + todo_list / task。 */
export function builtinTools(): AgentTool[] {
  // 具体工具各自收窄了输入类型（AgentTool<ReadInput> 等），此处统一为注册表用的宽类型。
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    shellTool,
    todoListTool,
    taskTool,
  ] as unknown as AgentTool[];
}

export function createBuiltinRegistry(): ToolRegistry {
  return new ToolRegistry().register(...builtinTools());
}
