import { Mode, PlanEntry, ToolState } from "../../shared/contracts/runtime";
import { analyzeCommand } from "./accessPolicy";

export type PlanPolicyDecision = {
  allowed: boolean;
  reason?: string;
};

const PLAN_CONTROLS = new Set(["ask_user", "submit_plan"]);

export function planPolicy(input: {
  args: Record<string, unknown>;
  mode: Mode;
  planEntry: PlanEntry;
  tool: ToolState;
}): PlanPolicyDecision {
  const { mode, planEntry, tool } = input;

  if (tool.toolName === "enter_plan") {
    if (mode === "plan") return { allowed: false, reason: "当前已经处于计划模式。" };
    if (planEntry === "manual") return { allowed: false, reason: "当前配置只允许用户手动进入计划模式。" };
    return { allowed: true };
  }

  if (PLAN_CONTROLS.has(tool.toolName)) {
    return mode === "plan"
      ? { allowed: true }
      : { allowed: false, reason: "该工具只能在计划模式中使用。" };
  }

  if (mode !== "plan") return { allowed: true };
  if (tool.toolName === "update_tasks") {
    return { allowed: false, reason: "计划模式只产出可审阅方案，不维护实施阶段的执行任务。" };
  }
  if (tool.toolName === "run_command") {
    return analyzeCommand(String(input.args.command ?? "")).planSafe
      ? { allowed: true }
      : { allowed: false, reason: "计划模式只允许单条、项目内、无副作用的检查命令。" };
  }
  if (tool.effect === "workspace_write" || tool.effect === "process_side_effect" || tool.effect === "external_side_effect") {
    return { allowed: false, reason: "计划模式禁止修改工作区、启动进程或产生外部副作用。" };
  }
  return { allowed: true };
}

export function hasConflictingControlStep(tools: ToolState[]): boolean {
  const hasControl = tools.some((tool) => tool.toolName === "enter_plan" || tool.toolName === "submit_plan" || tool.toolName === "ask_user");
  if (!hasControl) return false;
  return tools.some((tool) => tool.effect === "workspace_write" || tool.effect === "process_side_effect" || tool.effect === "external_side_effect");
}
