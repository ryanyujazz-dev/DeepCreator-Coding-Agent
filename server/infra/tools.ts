import {
  ActivityKind,
  ToolState,
  ActionKind,
  ToolMetrics
} from "../../shared/contracts/runtime";
import { analyzeCommand } from "../domain/accessPolicy";
import { ToolProgress, ToolResult } from "../../shared/contracts/tool";
import { PreparedToolState, ToolHost } from "../app/toolHost";
import { invokeCapability, searchCapabilities } from "./capabilities";
import { commandManager, CommandSnapshot } from "./commandManager";
import { summarizeToolArguments, summarizeToolResult } from "./tools/summaries";
import { runShell } from "./tools/shellExecution";
import { deleteFile, editFile, listFiles, multiEdit, readFile, writeFile } from "./tools/files";
import { globFiles, grepFiles } from "./tools/search";
import { fetchUrl, webSearch } from "./tools/web";
import { toolRegistry, toolSpecs, ToolRegistration } from "./tools/registry";
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

function managedCommandResult(snapshot: CommandSnapshot, mutatedWorkspace: boolean): ToolResult {
  return {
    command: snapshot.command,
    commandActivityId: snapshot.activityId,
    commandId: snapshot.commandId,
    commandRunId: snapshot.runId,
    commandSessionId: snapshot.sessionId,
    commandState: snapshot.state,
    elapsedMs: snapshot.elapsedMs,
    exitCode: snapshot.exitCode,
    mutatedWorkspace,
    output: snapshot.state === "running" ? snapshot.outputDelta : snapshot.output,
    outputTruncated: snapshot.outputTruncated
  };
}

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
}): Promise<ToolResult> {
  const { projectRoot, name, args, signal, onOutput, commandCheckpointMs } = input;
  if (name === "list_files") return { mutatedWorkspace: false, output: await listFiles(projectRoot, args) };
  if (name === "read_file") return { mutatedWorkspace: false, output: await readFile(projectRoot, args as never) };
  if (name === "grep") return { mutatedWorkspace: false, output: await grepFiles(projectRoot, args as never, signal) };
  if (name === "glob") return { mutatedWorkspace: false, output: await globFiles(projectRoot, args as never, signal) };
  if (name === "git_status") {
    const result = await runShell(projectRoot, "git status --short && git diff --stat", signal);
    return { ...result, mutatedWorkspace: false };
  }
  if (name === "search_capabilities") {
    const matches = searchCapabilities(projectRoot, String(args.query ?? ""), Number(args.limit ?? 10));
    return { mutatedWorkspace: false, output: JSON.stringify({ capabilities: matches }) };
  }
  if (name === "invoke_capability") {
    const loaded = await invokeCapability(
      projectRoot,
      String(args.capabilityId ?? ""),
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {},
      signal
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
  if (name === "write_file") return { mutatedWorkspace: true, output: await writeFile(projectRoot, args as never) };
  if (name === "edit_file") return { mutatedWorkspace: true, output: await editFile(projectRoot, args as never) };
  if (name === "multi_edit") return { mutatedWorkspace: true, output: await multiEdit(projectRoot, args as never) };
  if (name === "delete_file") return { mutatedWorkspace: true, output: await deleteFile(projectRoot, args as never) };
  if (name === "fetch_url") return { mutatedWorkspace: false, output: await fetchUrl(args as never, signal) };
  if (name === "web_search") return { mutatedWorkspace: false, output: await webSearch(args as never, signal) };
  if (name === "run_command") {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("command 不能为空。");
    if (!input.activityId || !input.runId || !input.sessionId) {
      throw new Error("run_command 缺少 Runtime 生命周期标识。");
    }
    const mutatedWorkspace = !analyzeCommand(command).readOnly;
    const snapshot = await commandManager.start({
      activityId: input.activityId,
      command,
      onOutput: (text) => onOutput?.({ text }),
      onSettled: (settled) => input.onCommandSettled?.(managedCommandResult(settled, mutatedWorkspace)),
      projectRoot,
      runId: input.runId,
      sessionId: input.sessionId,
      signal
    }, commandCheckpointMs);
    return managedCommandResult(snapshot, mutatedWorkspace);
  }
  if (name === "wait_command") {
    const commandId = String(args.commandId ?? "").trim();
    if (!commandId) throw new Error("commandId 不能为空。");
    const existing = commandManager.get(commandId);
    if (!existing) throw new Error(`未找到命令：${commandId}`);
    return managedCommandResult(
      await commandManager.wait(commandId, commandCheckpointMs, signal),
      !analyzeCommand(existing.command).readOnly
    );
  }
  if (name === "stop_command") {
    const commandId = String(args.commandId ?? "").trim();
    if (!commandId) throw new Error("commandId 不能为空。");
    const existing = commandManager.get(commandId);
    if (!existing) throw new Error(`未找到命令：${commandId}`);
    const stopped = await commandManager.stop(commandId);
    if (!stopped) throw new Error(`未找到命令：${commandId}`);
    return managedCommandResult(stopped, !analyzeCommand(existing.command).readOnly);
  }
  throw new Error(`未知工具：${name}`);
}



function registrationFor(name: string): ToolRegistration {
  const registration = toolRegistry.find((tool) => tool.name === (name === "spawn_agent" ? "delegate" : name));
  if (!registration) throw new Error(`未知工具：${name}`);
  return registration;
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
  if (name === "search_memory") return false;
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
    ask_user: "询问方案问题",
    delete_file: "删除文件",
    edit_file: "编辑文件",
    git_status: "检查 Git 状态",
    enter_plan: "进入计划模式",
    list_files: "列出项目文件",
    read_file: "读取文件",
    grep: "搜索文件内容",
    glob: "匹配文件路径",
    search_capabilities: "搜索能力",
    search_memory: "检索记忆",
    run_command: "运行命令",
    wait_command: "等待命令",
    stop_command: "停止命令",
    submit_plan: "提交实施方案",
    update_tasks: "更新执行任务",
    write_file: "写入文件",
    multi_edit: "批量编辑文件",
    fetch_url: "抓取网页",
    web_search: "联网搜索",
    delegate: "委派子代理",
    spawn_agent: "委派子代理"
  } as Record<string, string>)[name] ?? name;
}

export const toolHost: ToolHost = {
  capture: captureBaseline,
  changes: collectChanges,
  checkpoint: checkpointTarget,
  close: releaseBaseline,
  execute: executeTool,
  has: hasTool,
  kind: activityKindForTool,
  names: toolNames,
  parallel: toolCanRunInParallel,
  prepare: createToolState,
  retain: retainBaseline,
  runningCommands: (runId) => commandManager.running(runId),
  specs: toolSpecs,
  stopCommands: (runId) => commandManager.stopRun(runId),
  summarizeArgs: summarizeToolArguments,
  summarizeResult: summarizeToolResult,
  title: toolTitle
};
