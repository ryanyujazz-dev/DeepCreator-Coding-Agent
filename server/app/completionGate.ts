import { Run } from "../../shared/contracts/runtime";

const TASK_MAINTENANCE_NEUTRAL_TOOLS = new Set(["ask_user", "enter_plan", "submit_plan", "update_tasks"]);

export type CompletionBlock =
  | { issue: string; kind: "task_maintenance"; retryMessage: string };

export function finalTaskMaintenanceIssue(run: Run): string | undefined {
  if (run.tasks.length === 0) return undefined;
  const unfinished = run.tasks.filter((task) => task.status === "pending" || task.status === "running");
  if (unfinished.length > 0) return `仍有 ${unfinished.length} 个任务处于 pending 或 running 状态`;

  let lastTaskUpdate = -1;
  let lastWorkTool = -1;
  run.activities.forEach((activity, index) => {
    const toolName = activity.tool?.toolName;
    if (!toolName) return;
    if (toolName === "update_tasks" && activity.status === "completed") lastTaskUpdate = index;
    else if (!TASK_MAINTENANCE_NEUTRAL_TOOLS.has(toolName)) lastWorkTool = index;
  });
  if (lastTaskUpdate < lastWorkTool) return "最后一次 update_tasks 早于最后一次工作工具调用";
  if (lastTaskUpdate < 0) return "任务清单尚未通过 update_tasks 完成最终维护";
  return undefined;
}

export function evaluateCompletion(input: { run?: Run }): CompletionBlock | undefined {
  // 后台命令不再走重试门:runner 在 no-tool_calls 路径会先挂起等待命令 settle
  // 并把结果作为续写消息注入(harness 回调),门在这里只会看到已终态的命令。
  const issue = input.run ? finalTaskMaintenanceIssue(input.run) : undefined;
  if (!issue) return undefined;
  return {
    issue,
    kind: "task_maintenance",
    retryMessage: `当前文本不能作为最终回答，因为任务计划尚未完成收尾：${issue}。不要继续输出最终回答；请调用 update_tasks，提交完整且真实的任务列表，将已完成事项标记为 completed、受阻事项标记为 blocked，并确保没有 pending 或 running。update_tasks 可以与其他工作工具放在同一个 tool_calls 中，但收尾调用必须排在最后一项工作工具之后。收到工具结果后的下一轮再生成最终回答。`
  };
}
