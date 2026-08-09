import { ToolProgress, ToolResult } from "../../../shared/contracts/tool";
import { analyzeCommand } from "../../domain/accessPolicy";
import { commandManager, CommandSnapshot } from "../commandManager";
import { SkillCatalog } from "../skillCatalog";
import { skillScriptCommand } from "./skills";

type ManagedToolInput = {
  activityId?: string;
  checkpointMs?: number;
  onCommandSettled?: (result: ToolResult) => void;
  onOutput?: (progress: ToolProgress) => void;
  projectRoot: string;
  runId?: string;
  sessionId?: string;
  signal?: AbortSignal;
};

const skillCommandMutations = new Map<string, boolean>();

function result(snapshot: CommandSnapshot, mutatedWorkspace: boolean): ToolResult {
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

function lifecycle(input: ManagedToolInput, toolName: string): asserts input is ManagedToolInput & {
  activityId: string;
  runId: string;
  sessionId: string;
} {
  if (!input.activityId || !input.runId || !input.sessionId) throw new Error(`${toolName} 缺少 Runtime 生命周期标识。`);
}

export async function runCommandTool(input: ManagedToolInput, command: string): Promise<ToolResult> {
  if (!command) throw new Error("command 不能为空。");
  lifecycle(input, "run_command");
  const mutatedWorkspace = !analyzeCommand(command).readOnly;
  const snapshot = await commandManager.start({
    activityId: input.activityId,
    command,
    onOutput: (text) => input.onOutput?.({ text }),
    onSettled: (settled) => input.onCommandSettled?.(result(settled, mutatedWorkspace)),
    projectRoot: input.projectRoot,
    runId: input.runId,
    sessionId: input.sessionId,
    signal: input.signal
  }, input.checkpointMs);
  return result(snapshot, mutatedWorkspace);
}

export async function runSkillScriptTool(
  input: ManagedToolInput,
  catalog: SkillCatalog,
  args: Record<string, unknown>
): Promise<ToolResult> {
  lifecycle(input, "run_skill_script");
  const prepared = skillScriptCommand(catalog, input.projectRoot, args);
  const snapshot = await commandManager.start({
    activityId: input.activityId,
    command: prepared.command,
    env: prepared.env,
    onOutput: (text) => input.onOutput?.({ text }),
    onSettled: (settled) => input.onCommandSettled?.(result(settled, prepared.mutatesWorkspace)),
    projectRoot: input.projectRoot,
    runId: input.runId,
    sessionId: input.sessionId,
    signal: input.signal
  }, input.checkpointMs);
  skillCommandMutations.set(snapshot.commandId, prepared.mutatesWorkspace);
  return result(snapshot, prepared.mutatesWorkspace);
}

export async function waitCommandTool(input: ManagedToolInput, commandId: string): Promise<ToolResult> {
  if (!commandId) throw new Error("commandId 不能为空。");
  const existing = commandManager.get(commandId);
  if (!existing) throw new Error(`未找到命令：${commandId}`);
  const snapshot = await commandManager.wait(commandId, input.checkpointMs, input.signal);
  const output = result(snapshot, skillCommandMutations.get(commandId) ?? !analyzeCommand(existing.command).readOnly);
  if (snapshot.state !== "running") skillCommandMutations.delete(commandId);
  return output;
}

export async function stopCommandTool(commandId: string): Promise<ToolResult> {
  if (!commandId) throw new Error("commandId 不能为空。");
  const existing = commandManager.get(commandId);
  if (!existing) throw new Error(`未找到命令：${commandId}`);
  const stopped = await commandManager.stop(commandId);
  if (!stopped) throw new Error(`未找到命令：${commandId}`);
  const output = result(stopped, skillCommandMutations.get(commandId) ?? !analyzeCommand(existing.command).readOnly);
  skillCommandMutations.delete(commandId);
  return output;
}
