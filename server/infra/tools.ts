import {
  ActivityKind,
  ToolState,
  ActionKind,
  ToolMetrics
} from "../../shared/contracts/runtime";
import { ToolProgress, ToolResult } from "../../shared/contracts/tool";
import { PreparedToolState, ToolHost } from "../app/toolHost";
import type { FileStateStore } from "../app/fileStateStore";
import { invokeCapability, searchCapabilities } from "./capabilities";
import { defaultSkillCatalog, SkillCatalog } from "./skillCatalog";
import { commandManager } from "./commandManager";
import { summarizeToolArguments, summarizeToolResult } from "./tools/summaries";
import { runShell } from "./tools/shellExecution";
import { deleteFile, editFile, listFiles, multiEdit, readFile, writeFile, type FileToolContext } from "./tools/files";
import { applyPatch } from "./tools/applyPatch";
import { globFiles, grepFiles } from "./tools/search";
import { fetchUrl, webSearch } from "./tools/web";
import { materializeSkillAsset, readSkillResource } from "./tools/skills";
import { runCommandTool, runSkillScriptTool, stopCommandTool } from "./tools/managedCommands";
import { gitCommit, gitDiff } from "./tools/git";
import { installSkill, previewSkillInstall } from "./tools/skillInstall";
import { toolRegistry, toolSpecs, ToolRegistration } from "./tools/registry";
import { SkillStore } from "./skillStore";
import {
  captureBaseline,
  checkpointTarget,
  collectChanges,
  releaseBaseline,
  retainBaseline
} from "./tools/changes";

export { redactSensitiveText } from "./tools/security";
export { summarizeToolArguments, summarizeToolResult } from "./tools/summaries";
export { captureBaseline, checkpointTarget, collectChanges, releaseBaseline, retainBaseline };
export { toolSpecs };

export async function executeTool(input: {
  activityId?: string;
  projectRoot: string;
  name: string;
  args: Record<string, unknown>;
  onCommandSettled?: (result: ToolResult) => void;
  signal?: AbortSignal;
  onOutput?: (progress: ToolProgress) => void;
  commandCheckpointMs?: number;
  runId?: string;
  sessionId?: string;
  skillCatalog?: SkillCatalog;
  skillStore?: SkillStore;
  fileState?: FileStateStore;
}): Promise<ToolResult> {
  const { projectRoot, name, args, signal, commandCheckpointMs } = input;
  const skillCatalog = input.skillCatalog ?? defaultSkillCatalog;
  const fileCtx: FileToolContext | undefined = input.runId && input.fileState ? { runId: input.runId, fileState: input.fileState } : undefined;
  if (name === "list_files") return { mutatedWorkspace: false, output: await listFiles(projectRoot, args) };
  if (name === "read_file") return { mutatedWorkspace: false, output: await readFile(projectRoot, args as never, fileCtx) };
  if (name === "grep") return { mutatedWorkspace: false, output: await grepFiles(projectRoot, args as never, signal) };
  if (name === "glob") return { mutatedWorkspace: false, output: await globFiles(projectRoot, args as never, signal) };
  if (name === "git_status") {
    const result = await runShell(projectRoot, "git status --short && git diff --stat", signal);
    return { ...result, mutatedWorkspace: false };
  }
  if (name === "git_diff") {
    const result = await gitDiff(projectRoot, args as never, signal);
    return { ...result, mutatedWorkspace: false };
  }
  if (name === "git_commit") {
    const result = await gitCommit(projectRoot, args as never, signal);
    return { ...result, mutatedWorkspace: true };
  }
  if (name === "search_capabilities") {
    const matches = searchCapabilities(projectRoot, String(args.query ?? ""), Number(args.limit ?? 10), skillCatalog);
    return { mutatedWorkspace: false, output: JSON.stringify({ capabilities: matches }) };
  }
  if (name === "invoke_capability") {
    const loaded = await invokeCapability(
      projectRoot,
      String(args.capabilityId ?? ""),
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {},
      signal,
      skillCatalog
    );
    return {
      contextUpdate: loaded.contextUpdate ? {
        metadata: {
          capabilityId: loaded.capability.capabilityId,
          label: loaded.capability.name,
          revisionHash: loaded.capability.revisionHash,
          sourceFile: loaded.capability.source,
          updateKind: loaded.capability.kind === "skill" ? "skill" : "capability"
        },
        text: loaded.contextUpdate
      } : undefined,
      mutatedWorkspace: false,
      output: loaded.output ?? JSON.stringify({ activated: Boolean(loaded.contextUpdate), capability: loaded.capability })
    };
  }
  if (name === "read_skill_resource") {
    return { mutatedWorkspace: false, output: readSkillResource(skillCatalog, projectRoot, args) };
  }
  if (name === "materialize_skill_asset") {
    return { mutatedWorkspace: true, output: materializeSkillAsset(skillCatalog, projectRoot, args) };
  }
  if (name === "preview_skill_install") {
    if (!input.skillStore) throw new Error("当前 Runtime 未配置 Skill 安装服务。");
    return previewSkillInstall({ args, projectRoot, store: input.skillStore });
  }
  if (name === "install_skill") {
    if (!input.skillStore) throw new Error("当前 Runtime 未配置 Skill 安装服务。");
    return installSkill({ args, projectRoot, store: input.skillStore });
  }
  if (name === "write_file") return { mutatedWorkspace: true, output: await writeFile(projectRoot, args as never, fileCtx) };
  if (name === "edit_file") return { mutatedWorkspace: true, output: await editFile(projectRoot, args as never, fileCtx) };
  if (name === "multi_edit") return { mutatedWorkspace: true, output: await multiEdit(projectRoot, args as never, fileCtx) };
  if (name === "delete_file") return { mutatedWorkspace: true, output: await deleteFile(projectRoot, args as never) };
  if (name === "apply_patch") return { mutatedWorkspace: true, output: await applyPatch(projectRoot, args as never, fileCtx) };
  if (name === "fetch_url") return { mutatedWorkspace: false, output: await fetchUrl(args as never, signal) };
  if (name === "web_search") return { mutatedWorkspace: false, output: await webSearch(args as never, signal) };
  if (name === "run_command") {
    const command = String(args.command ?? "").trim();
    // timeout_ms:模型可调前台等待上限(clamp 1..600000);run_in_background=true 时
    // checkpointMs=1 → start() 的 wait 立即到点 → backgrounded,返回 running snapshot。
    const requestedTimeout = Number(args.timeout_ms ?? 120_000);
    const timeoutMs = args.run_in_background === true
      ? 1
      : Math.min(600_000, Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : 120_000));
    return runCommandTool({
      ...input,
      checkpointMs: timeoutMs
    }, command);
  }
  if (name === "run_skill_script") {
    return runSkillScriptTool({ ...input, checkpointMs: commandCheckpointMs }, skillCatalog, args);
  }
  if (name === "stop_command") {
    const commandId = String(args.commandId ?? "").trim();
    return stopCommandTool(commandId);
  }
  throw new Error(`未知工具：${name}`);
}



function registrationFor(name: string): ToolRegistration {
  const registration = toolRegistry.find((tool) => tool.name === (name === "spawn_agent" ? "delegate" : name));
  if (!registration) throw new Error(`未知工具：${name}`);
  return registration;
}

/** 预开占位元数据(无需 args):从 registration 的 presentation 取 action/targetKind/effect,给模型流式输出
 *  tool_call name 时(还无合法 args,不能 prepare)的 activity 占位 ToolState 用。执行时 toolPipeline 复用
 *  分支 durableToolState(prepared) 覆盖为精确值。未知工具抛(调用方应先 has 校验)。 */
function toolOutline(name: string): { action: ActionKind; effect: ToolState["effect"]; targetKind: ToolState["targetKind"] } {
  const presentation = registrationFor(name).presentation;
  return { action: presentation.action, effect: presentation.effect, targetKind: presentation.targetKind };
}

export function hasTool(name: string): boolean {
  return name === "spawn_agent" || toolRegistry.some((tool) => tool.name === name);
}

export function toolNames(): string[] {
  return toolRegistry.map((tool) => tool.name);
}

export function toolCanRunInParallel(name: string): boolean {
  if (name === "delegate" || name === "spawn_agent") return true;
  if (name === "run_command") return true;
  if (name === "search_memory" || name === "save_memory") return false;
  const registration = toolRegistry.find((tool) => tool.name === name);
  return registration?.presentation.effect === "read_only";
}

export function createToolState(input: {
  args?: Record<string, unknown>;
  argumentsPreview?: string;
  callId: string;
  modelStepId: string;
  name: string;
  projectRoot: string;
  result?: ToolResult;
  output?: string;
}): PreparedToolState {
  const registration = registrationFor(input.name);
  const args = input.args ?? {};
  const overrides = registration.presentation.resolveSemantics?.(args) ?? {};
  const presentation = { ...registration.presentation, ...overrides };
  const target = presentation.resolveTarget(args, input.projectRoot);
  return {
    groupMode: presentation.groupMode,
    argumentsPreview: input.argumentsPreview ?? "",
    callId: input.callId,
    detail: presentation.detail,
    displayTarget: target,
    effect: presentation.effect,
    importance: presentation.importance,
    modelStepId: input.modelStepId,
    normalizedTarget: target.trim().replaceAll("\\", "/"),
    action: presentation.action,
    targetKind: presentation.targetKind,
    resultMetrics: input.result && input.output
      ? resultMetricsFor(input.name, args, input.output, input.result, presentation.action)
      : undefined,
    resultSummary: input.output ? summarizeToolResult(input.name, args, input.output).slice(0, 500) : undefined,
    toolName: input.name
  };
}

function resultMetricsFor(
  name: string,
  args: Record<string, unknown>,
  output: string,
  result: ToolResult,
  action: ActionKind
): ToolMetrics {
  const lines = output.split("\n").filter(Boolean).length;
  const grepItemCount = name === "grep" ? (() => {
    const mode = String(args.output_mode ?? "files_with_matches");
    if (mode === "json") {
      try {
        const hits = JSON.parse(output) as Array<{ path?: string }>;
        return new Set(hits.map((hit) => hit.path).filter(Boolean)).size;
      } catch {
        return undefined;
      }
    }
    const paths = output.split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("(") && line !== "未找到匹配内容。")
      .map((line) => mode === "files_with_matches" ? line : line.split(":", 1)[0]);
    return new Set(paths).size;
  })() : undefined;
  return {
    byteCount: Buffer.byteLength(output),
    exitCode: result.exitCode,
    itemCount: name === "grep"
      ? grepItemCount
      : name === "list_files" || name === "glob"
        ? lines
        : name === "read_file" || action === "modify" ? 1 : undefined,
    matchCount: action === "search" ? lines : undefined,
    timedOut: result.timedOut,
    truncated: name === "read_file" && output.length >= Number(args.maxChars ?? 40_000)
  };
}

export function activityKindForTool(tool: ToolState): ActivityKind {
  if (tool.toolName === "delegate" || tool.toolName === "spawn_agent") return "delegation";
  if (tool.toolName === "submit_plan") return "plan";
  if (tool.action === "modify") return "file_mutation";
  if (tool.action === "execute" || tool.action === "verify") return "command";
  return "tool";
}

export function toolTitle(name: string): string {
  return ({
    invoke_capability: "启用能力",
    read_skill_resource: "读取 Skill 参考资料",
    materialize_skill_asset: "创建 Skill 资源",
    preview_skill_install: "预览 Skill 安装",
    install_skill: "安装 Skill",
    run_skill_script: "运行 Skill 脚本",
    ask_user: "询问方案问题",
    delete_file: "删除文件",
    edit_file: "编辑文件",
    git_status: "检查 Git 状态",
    git_diff: "查看 Git 改动",
    git_commit: "提交 Git 改动",
    enter_plan: "进入计划模式",
    list_files: "列出项目文件",
    read_file: "读取文件",
    grep: "搜索文件内容",
    glob: "匹配文件路径",
    search_capabilities: "搜索能力",
    search_memory: "检索记忆",
    save_memory: "保存记忆",
    run_command: "运行命令",
    stop_command: "停止命令",
    submit_plan: "提交实施方案",
    update_tasks: "更新执行任务",
    write_file: "写入文件",
    multi_edit: "批量编辑文件",
    apply_patch: "应用补丁",
    fetch_url: "抓取网页",
    web_search: "联网搜索",
    delegate: "委派子代理",
    spawn_agent: "委派子代理"
  } as Record<string, string>)[name] ?? name;
}

export function createToolHost(skillCatalog = defaultSkillCatalog, skillStore?: SkillStore, fileState?: FileStateStore): ToolHost {
  return {
    capture: captureBaseline,
    changes: collectChanges,
    checkpoint: checkpointTarget,
    close: releaseBaseline,
    execute: (input) => executeTool({ ...input, skillCatalog, skillStore, fileState }),
    has: hasTool,
    kind: activityKindForTool,
    names: toolNames,
    outline: toolOutline,
    parallel: toolCanRunInParallel,
    prepare: createToolState,
    retain: retainBaseline,
    runningCommands: (runId) => commandManager.running(runId),
    specs: toolSpecs,
    stopCommands: (runId) => commandManager.stopRun(runId),
    takeSettledCommands: (runId) => commandManager.takeSettled(runId),
    waitForSettled: (runId, signal, maxWaitMs) => commandManager.waitForSettled(runId, signal, maxWaitMs),
    summarizeArgs: summarizeToolArguments,
    summarizeResult: summarizeToolResult,
    title: toolTitle
  };
}

export const toolHost: ToolHost = createToolHost();
