import { ActionKind, Activity, ToolState } from "../contracts/runtime";
import { ToolImportance } from "./types";

const TOOL_LABELS: Record<string, string> = {
  ask_user: "询问方案问题",
  delete_file: "删除文件",
  edit_file: "编辑文件",
  enter_plan: "进入计划模式",
  git_status: "检查 Git 状态",
  glob: "匹配文件路径",
  grep: "搜索文件内容",
  invoke_capability: "启用能力",
  list_files: "列出项目文件",
  read_file: "读取文件",
  run_command: "运行命令",
  search_capabilities: "搜索能力",
  search_memory: "检索记忆",
  stop_command: "停止命令",
  submit_plan: "提交实施方案",
  update_tasks: "更新执行任务",
  wait_command: "等待命令",
  write_file: "写入文件"
};

export function toolTarget(tool: ToolState | undefined): string {
  return tool?.displayTarget || tool?.normalizedTarget || "";
}

export function toolImportance(tool: ToolState | undefined): ToolImportance {
  if (tool?.importance) return tool.importance;
  if (tool?.toolName === "delete_file") return "critical";
  if (tool?.action === "modify" || tool?.action === "verify" || tool?.action === "execute") return "notable";
  return "routine";
}

export function activityTitle(activity: Pick<Activity, "kind" | "title" | "tool">): string {
  if (activity.title) return activity.title;
  if (activity.tool) return TOOL_LABELS[activity.tool.toolName] ?? activity.tool.toolName;
  return ({
    command: "运行命令",
    compaction: "正在压缩上下文",
    error: "运行错误",
    file_mutation: "修改文件",
    message: "回复",
    plan: "正在编写计划",
    thinking: "正在思考",
    tool: "使用工具"
  } satisfies Record<Activity["kind"], string>)[activity.kind];
}

export function completedActionLabel(action: ActionKind, target: string): string | undefined {
  if (!target) return undefined;
  if (action === "modify") return `已修改 ${target}`;
  if (action === "inspect" || action === "search") return `已检查 ${target}`;
  return undefined;
}
