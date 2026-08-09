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
  install_skill: "安装 Skill",
  materialize_skill_asset: "创建 Skill 资源",
  list_files: "列出项目文件",
  read_file: "读取文件",
  read_skill_resource: "读取 Skill 参考资料",
  preview_skill_install: "预览 Skill 安装",
  run_command: "运行命令",
  run_skill_script: "运行 Skill 脚本",
  search_capabilities: "搜索能力",
  search_memory: "检索记忆",
  stop_command: "停止命令",
  submit_plan: "提交实施方案",
  update_tasks: "更新执行任务",
  wait_command: "等待命令",
  write_file: "写入文件"
};

const SKILL_TOOL_NAMES = new Set([
  "invoke_capability",
  "install_skill",
  "materialize_skill_asset",
  "preview_skill_install",
  "read_skill_resource",
  "run_skill_script",
  "search_capabilities"
]);

const SKILL_ACTIVITY_LABELS: Record<string, Record<Activity["status"], string>> = {
  invoke_capability: {
    cancelled: "已取消加载 Skill",
    completed: "已加载 Skill",
    failed: "加载 Skill 失败",
    running: "正在加载 Skill",
    suspended: "已暂停加载 Skill"
  },
  install_skill: {
    cancelled: "已取消安装 Skill",
    completed: "已安装 Skill",
    failed: "安装 Skill 失败",
    running: "正在安装 Skill",
    suspended: "等待确认安装 Skill"
  },
  materialize_skill_asset: {
    cancelled: "已取消创建 Skill 资源",
    completed: "已创建 Skill 资源",
    failed: "创建 Skill 资源失败",
    running: "正在创建 Skill 资源",
    suspended: "已暂停创建 Skill 资源"
  },
  preview_skill_install: {
    cancelled: "已取消预览 Skill 安装",
    completed: "已生成 Skill 安装预览",
    failed: "生成 Skill 安装预览失败",
    running: "正在生成 Skill 安装预览",
    suspended: "已暂停生成 Skill 安装预览"
  },
  read_skill_resource: {
    cancelled: "已取消读取 Skill 参考资料",
    completed: "已读取 Skill 参考资料",
    failed: "读取 Skill 参考资料失败",
    running: "正在读取 Skill 参考资料",
    suspended: "已暂停读取 Skill 参考资料"
  },
  run_skill_script: {
    cancelled: "已取消运行 Skill 脚本",
    completed: "已运行 Skill 脚本",
    failed: "运行 Skill 脚本失败",
    running: "正在运行 Skill 脚本",
    suspended: "已暂停运行 Skill 脚本"
  },
  search_capabilities: {
    cancelled: "已取消搜索 Skill",
    completed: "已搜索 Skill",
    failed: "搜索 Skill 失败",
    running: "正在搜索 Skill",
    suspended: "已暂停搜索 Skill"
  }
};

export function isSkillActivity(activity: Pick<Activity, "tool">): boolean {
  return Boolean(activity.tool && SKILL_TOOL_NAMES.has(activity.tool.toolName));
}

export function skillActivityLabel(activity: Pick<Activity, "status" | "tool">): string | undefined {
  if (!activity.tool) return undefined;
  const label = SKILL_ACTIVITY_LABELS[activity.tool.toolName]?.[activity.status];
  if (!label) return undefined;
  const target = toolDisplayTarget(activity.tool);
  return target ? `${label} · ${target}` : label;
}

export function toolTarget(tool: ToolState | undefined): string {
  return tool?.displayTarget || tool?.normalizedTarget || "";
}

export function fileDisplayName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? filePath;
}

export function toolDisplayTarget(tool: ToolState | undefined): string {
  const target = toolTarget(tool);
  return tool?.targetKind === "file" ? fileDisplayName(target) : target;
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
    delegation: "委派子代理",
    error: "运行错误",
    file_mutation: "修改文件",
    message: "回复",
    user_message: "用户引导",
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
