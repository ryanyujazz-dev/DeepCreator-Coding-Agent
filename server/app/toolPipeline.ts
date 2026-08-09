import { ContextInput } from "../../shared/contracts/context";
import { ModelMessage, ToolCall } from "../../shared/contracts/provider";
import { AgentId, AggregateHeadlineKind, EventPayloadMap, ToolState } from "../../shared/contracts/runtime";
import { Baseline } from "../../shared/contracts/tool";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import { analyzeCommand, approvalFor } from "../domain/accessPolicy";
import { reduceToolEvidence } from "./evidence";
import { hasConflictingControlStep, planPolicy } from "../domain/planPolicy";
import { contextUpdateRecord, findNewPathInstructions } from "./contextBuilder";
import { RunRegistry } from "./runRegistry";
import { ContextPort, EventPort, EvidencePort, MemoryPort, SessionPort } from "./runtimeRepo";
import { ToolHost } from "./toolHost";
import { durableToolState } from "./toolFacts";
import { finishActivity as finishActivityOnce, updateActivity } from "./activityLifecycle";
import { ControlToolHandlers } from "./controlToolHandlers";
import { SystemPort } from "./systemPort";
import { workspaceMutationCoordinator } from "./workspaceMutationCoordinator";
import { agentDefinition, stricterAccess } from "./agentDefinitions";
import { pathsFromApplyPatch } from "../domain/applyPatch";

export type ToolContext = {
  baseline: Baseline;
  projectRoot: string;
  registry: RunRegistry;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  store: ContextPort & EventPort & EvidencePort & MemoryPort & SessionPort;
};

export type ToolOutcome = {
  contextRecords: ContextInput[];
  evidenceRecords?: ContextInput[];
  message?: ModelMessage;
  mutatedWorkspace: boolean;
  protocolError: boolean;
  suspended?: boolean;
  target?: string;
};

function parseArgs(text: string): Record<string, unknown> {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("工具参数不是有效的 JSON。");
  }
}

function patchTextFromArguments(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as { patch?: unknown };
    return typeof parsed.patch === "string" ? parsed.patch : argumentsText;
  } catch {
    return argumentsText;
  }
}

function openActivity(input: ToolContext, data: EventPayloadMap["activity.started"], activityId = input.registry.system.createId("activity")): string {
  input.store.append({
    activityId,
    data: { ...data, tool: durableToolState(data.tool) },
    runId: input.runId,
    sessionId: input.sessionId,
    type: "activity.started"
  });
  return activityId;
}

function finishActivity(
  input: ToolContext,
  activityId: string,
  data: Omit<EventPayloadMap["activity.finished"], "finishedAt">
): boolean {
  const durableData = data.tool === undefined
    ? data
    : { ...data, tool: durableToolState(data.tool) };
  return finishActivityOnce({
    activityId,
    runId: input.runId,
    sessionId: input.sessionId,
    store: input.store,
    system: input.registry.system
  }, durableData);
}

export type DelegateHandler = (args: {
  activityId: string;
  agent: AgentId;
  callId: string;
  message: string;
}) => { agentId: AgentId; childRunId: string; childSessionId: string; delegationId: string; status: string };

export class ToolPipeline {
  private readonly controlTools: ControlToolHandlers;

  constructor(
    private readonly host: ToolHost,
    private readonly rules: RuleSource = emptyRuleSource,
    private readonly system: SystemPort,
    private readonly delegateAgent?: DelegateHandler
  ) {
    this.controlTools = new ControlToolHandlers(this.host, {
      createId: this.system.createId,
      finishActivity,
      now: this.system.now,
      record: (input, call, modelStepId, text, metadata, isError) =>
        this.record(input, call, modelStepId, text, metadata, isError)
    }, this.delegateAgent);
  }

  stepRejection(calls: ToolCall[], modelStepId: string, projectRoot: string): string | undefined {
    const tools = calls.flatMap((call): ToolState[] => {
      try {
        if (!this.host.has(call.name)) return [];
        const args = parseArgs(call.argumentsText);
        return [this.host.prepare({
          args,
          argumentsPreview: this.host.summarizeArgs(call.name, args),
          callId: call.callId,
          modelStepId,
          name: call.name,
          projectRoot
        })];
      } catch {
        return [];
      }
    });
    if (tools.some((tool) => tool.toolName === "enter_plan" || tool.toolName === "submit_plan" || tool.toolName === "ask_user") && tools.length > 1) {
      return "模式控制或暂停工具必须是当前模型步骤中的唯一工具调用。";
    }
    return hasConflictingControlStep(tools)
      ? "模式控制工具不能与产生副作用的工具出现在同一个模型步骤中。"
      : undefined;
  }

  async run(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    knownRuleIds: Set<string>,
    existingActivityId?: string,
    stepRejection?: string,
    stepHeadline?: AggregateHeadlineKind
  ): Promise<ToolOutcome> {
    let activityId = existingActivityId;
    let retainedCommandBaseline = false;
    let workspaceRelease: (() => void) | undefined;
    let workspaceLeaseTransferred = false;
    try {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("当前工具步骤已中断。", "AbortError");
      // normalize
      const args = parseArgs(call.argumentsText);
      const argsSummary = this.host.summarizeArgs(call.name, args);

      // validate
      if (!this.host.has(call.name)) throw new Error(`未知工具：${call.name}。可用工具：${this.host.names().join(", ")}`);
      const prepared = {
        ...this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        projectRoot: input.projectRoot
        }),
        callIndex: call.index,
        stepHeadline
      };
      if (call.name === "wait_command" || call.name === "stop_command") {
        return await this.controlManagedCommand(input, call, modelStepId, args, prepared);
      }
      activityId ??= openActivity(input, {
        audience: "user",
        kind: this.host.kind(prepared),
        startedAt: input.registry.system.now(),
        tool: prepared
      });
      if (existingActivityId) {
        input.store.append({
          activityId,
          data: { kind: this.host.kind(prepared), tool: durableToolState(prepared) },
          runId: input.runId,
          sessionId: input.sessionId,
          type: "activity.updated"
        });
      }

      const session = input.store.getSession(input.sessionId)!;
      if (stepRejection) return this.reject(input, call, modelStepId, activityId, prepared, stepRejection);
      if (call.name === "enter_plan" && input.store.getRun(input.runId)?.changes.fileCount) {
        return this.reject(input, call, modelStepId, activityId, prepared, "当前运行已经修改工作区，不能再进入计划模式。");
      }
      const policy = planPolicy({ args, mode: session.mode, planEntry: session.planEntry, tool: prepared });
      if (!policy.allowed) return this.reject(input, call, modelStepId, activityId, prepared, policy.reason ?? "当前模式不允许该操作。");

      const controlOutcome = await this.controlTools.handle({
        activityId,
        args,
        argsSummary,
        call,
        context: input,
        modelStepId,
        prepared
      });
      if (controlOutcome) return controlOutcome;

      const target = prepared.normalizedTarget;
      const mutationTargets = call.name === "apply_patch"
        ? pathsFromApplyPatch(String(args.patch ?? ""))
        : ["write_file", "edit_file", "delete_file"].includes(call.name) && target ? [target] : [];
      const preflight = mutationTargets.length > 0
        ? findNewPathInstructions(input.projectRoot, mutationTargets, knownRuleIds, this.rules)
        : [];
      if (preflight.length > 0) {
        const text = `操作尚未执行：目标 ${target} 首次命中 ${preflight.length} 项路径规范。Runtime 已加载规范，请在读取后重新发起操作。`;
        finishActivity(input, activityId, { body: text, status: "completed", tool: { ...prepared, resultSummary: text } });
        this.record(input, call, modelStepId, text, { guidancePreflight: true, action: prepared.action, target });
        const update = contextUpdateRecord(input.sessionId, input.runId, preflight, "mutation_preflight", this.rules);
        for (const rule of preflight) knownRuleIds.add(rule.instructionKey);
        return {
          contextRecords: update ? [update] : [],
          message: { role: "tool", text, toolCallKey: call.callId },
          mutatedWorkspace: false,
          protocolError: false,
          target
        };
      }

      if (call.name === "apply_patch") {
        const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
        updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
          draft: current?.draft ?? { kind: "apply_patch", state: "unapplied", text: String(args.patch ?? "") },
          title: "补丁草稿待应用"
        });
      }

      // authorize
      const parentAccess = session.kind === "subagent" && session.parentSessionId
        ? input.store.getSession(session.parentSessionId)?.accessMode
        : undefined;
      const profile = session.kind === "subagent" && session.agentId
        ? stricterAccess(session.accessMode, stricterAccess(parentAccess ?? "request_approval", agentDefinition(session.agentId).maxAccessMode))
        : session.accessMode;
      const approval = approvalFor({ args, grants: session.grants, profile, runId: input.runId, toolName: call.name });
      if (approval) {
        if (call.name === "apply_patch") {
          const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            draft: current?.draft ? { ...current.draft, state: "waiting_approval" } : undefined,
            status: "suspended",
            title: "等待批准补丁"
          });
        } else if (call.name === "install_skill") {
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            status: "suspended",
            title: "等待确认安装 Skill"
          });
        }
        const decision = await input.registry.requestApproval({
          ...approval,
          callId: call.callId,
          runId: input.runId,
          sessionId: input.sessionId,
          signal: input.signal,
          store: input.store,
          toolName: call.name
        });
        if (decision === "deny") {
          if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("当前工具步骤已中断。", "AbortError");
          const text = "用户拒绝了本次操作，请不要再次尝试同一操作。";
          finishActivity(input, activityId, {
            body: "用户拒绝了本次操作。",
            draft: call.name === "apply_patch" ? { kind: "apply_patch", state: "unapplied", text: String(args.patch ?? "") } : undefined,
            status: "cancelled",
            tool: { ...prepared, resultSummary: "用户拒绝了本次操作。" }
          });
          this.record(input, call, modelStepId, text, { action: prepared.action, target: prepared.normalizedTarget }, true);
          return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target };
        }
        if (call.name === "apply_patch") {
          const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            draft: current?.draft ? { ...current.draft, state: "applying" } : undefined,
            status: "running",
            title: "正在应用补丁"
          });
        } else if (call.name === "install_skill") {
          updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
            status: "running",
            title: "正在安装 Skill"
          });
        }
      }
      if (call.name === "apply_patch" && !approval) {
        const current = input.store.getRun(input.runId)?.activities.find((activity) => activity.activityId === activityId);
        updateActivity({ activityId, runId: input.runId, sessionId: input.sessionId, store: input.store }, {
          draft: current?.draft ? { ...current.draft, state: "applying" } : undefined,
          status: "running",
          title: "正在应用补丁"
        });
      }

      // checkpoint
      if (["write_file", "edit_file", "delete_file"].includes(call.name)) {
        await this.host.checkpoint(input.projectRoot, input.baseline, String(args.path ?? ""));
      }
      if (call.name === "apply_patch") {
        for (const patchPath of mutationTargets) await this.host.checkpoint(input.projectRoot, input.baseline, patchPath);
      }

      // execute
      const startsManagedCommand = call.name === "run_command" || call.name === "run_skill_script";
      const mutatesWorkspace = prepared.effect === "workspace_write"
        || (call.name === "run_command" && !analyzeCommand(String(args.command ?? "")).readOnly)
        || call.name === "run_skill_script";
      if (mutatesWorkspace) workspaceRelease = await workspaceMutationCoordinator.acquire(input.projectRoot, input.signal);
      if (startsManagedCommand) {
        this.host.retain(input.baseline);
        retainedCommandBaseline = true;
      }
      const result = await this.host.execute({
        activityId,
        args,
        name: call.name,
        onCommandSettled: startsManagedCommand ? (settled) => {
          void this.settleManagedCommand(input, activityId!, settled, true)
            .finally(() => workspaceMutationCoordinator.releaseCommand(settled.commandId));
        } : undefined,
        onOutput: startsManagedCommand ? ({ text }) => {
          updateActivity({ activityId: activityId!, runId: input.runId, sessionId: input.sessionId, store: input.store }, { bodyDelta: text });
        } : undefined,
        projectRoot: input.projectRoot,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal
      });
      if (workspaceRelease && result.commandState === "running" && result.commandId) {
        workspaceMutationCoordinator.retainForCommand(result.commandId, workspaceRelease);
        workspaceLeaseTransferred = true;
      }
      if (startsManagedCommand && result.commandState !== "running") {
        retainedCommandBaseline = false;
        await this.host.close(input.baseline);
      } else if (startsManagedCommand) {
        retainedCommandBaseline = false;
      }

      if (result.mutatedWorkspace) {
        const changes = await this.host.changes(input.projectRoot, input.baseline);
        const normalizedTarget = prepared.normalizedTarget.replaceAll("\\", "/");
        const files = call.name === "apply_patch"
          ? changes.files.filter((file) => mutationTargets.includes(file.path.replaceAll("\\", "/")))
          : changes.files.filter((file) => file.path.replaceAll("\\", "/") === normalizedTarget);
        input.store.appendMany([{
          data: changes,
          runId: input.runId,
          sessionId: input.sessionId,
          type: "changes.changed"
        }, {
          activityId,
          data: { files },
          runId: input.runId,
          sessionId: input.sessionId,
          type: "activity.updated"
        }]);
      }

      // record
      const completed = {
        ...this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        output: result.output,
        projectRoot: input.projectRoot,
        result
        }),
        callIndex: call.index,
        stepHeadline
      };
      const command = result.command ? {
        command: result.command,
        commandId: result.commandId,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        outputTruncated: result.outputTruncated,
        state: result.commandState,
        timedOut: result.timedOut
      } : undefined;
      if (result.commandState === "running") {
        input.store.append({
          activityId,
          data: { command, tool: durableToolState(completed) },
          runId: input.runId,
          sessionId: input.sessionId,
          type: "activity.updated"
        });
      } else {
        finishActivity(input, activityId, {
          body: this.host.summarizeResult(call.name, args, result.output),
          command,
          draft: call.name === "apply_patch" ? { kind: "apply_patch", state: "applied", text: String(args.patch ?? "") } : undefined,
          status: result.commandState === "cancelled"
            ? "cancelled"
            : result.exitCode && result.exitCode !== 0 ? "failed" : "completed",
          tool: completed
        });
      }
      const evidence = reduceToolEvidence(call.name, result);
      const recordId = input.registry.system.createId("context");
      const evidenceRecord: ContextInput = {
        artifactRef: input.store.storeEvidence(input.sessionId, recordId, evidence.fullText),
        isError: Boolean(result.exitCode && result.exitCode !== 0),
        kind: "tool_result",
        metadata: {
          digest: evidence.digest,
          modelStepId,
          action: completed.action,
          originalBytes: evidence.originalBytes,
          retainedBytes: evidence.retainedBytes,
          target: completed.normalizedTarget
        },
        recordId,
        runId: input.runId,
        sessionId: input.sessionId,
        source: "tool",
        text: evidence.modelText,
        toolCallKey: call.callId,
        toolName: call.name,
        wasTruncated: evidence.wasTruncated
      };
      const capabilityRecord: ContextInput | undefined = result.contextUpdate ? {
        kind: "context_update",
        metadata: result.contextUpdate.metadata,
        runId: input.runId,
        sessionId: input.sessionId,
        source: "runtime",
        text: result.contextUpdate.text
      } : undefined;
      const discovered = target && completed.targetKind === "file"
        ? findNewPathInstructions(input.projectRoot, [target], knownRuleIds, this.rules)
        : [];
      const update = discovered.length > 0 ? contextUpdateRecord(input.sessionId, input.runId, discovered, "read_result", this.rules) : undefined;
      for (const rule of discovered) knownRuleIds.add(rule.instructionKey);
      return {
        contextRecords: [capabilityRecord, update].filter((record): record is ContextInput => Boolean(record)),
        evidenceRecords: [evidenceRecord],
        message: { role: "tool", text: evidence.modelText, toolCallKey: call.callId },
        mutatedWorkspace: result.mutatedWorkspace,
        protocolError: false,
        target: completed.normalizedTarget
      };
    } catch (error) {
      if (retainedCommandBaseline) await this.host.close(input.baseline).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      activityId ??= openActivity(input, {
        audience: "user",
        body: "",
        kind: "tool",
        startedAt: input.registry.system.now()
      });
      const activity = input.store.getRun(input.runId)?.activities.find((item) => item.activityId === activityId);
      finishActivity(input, activityId, activity?.kind === "plan"
        ? { error: message, status: "failed" }
        : {
            body: message,
            draft: call.name === "apply_patch" ? { kind: "apply_patch", state: "failed", text: patchTextFromArguments(call.argumentsText) } : undefined,
            error: message,
            status: "failed"
          });
      const text = `工具执行失败：${message}`;
      this.record(input, call, modelStepId, text, { action: "execute", target: call.name || "未知工具" }, true);
      return {
        contextRecords: [],
        message: { role: "tool", text, toolCallKey: call.callId },
        mutatedWorkspace: false,
        protocolError: /未知工具|有效的 JSON|格式无效|参数/.test(message),
        target: call.name
      };
    } finally {
      if (workspaceRelease && !workspaceLeaseTransferred) workspaceRelease();
    }
  }

  private async controlManagedCommand(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    args: Record<string, unknown>,
    prepared: ToolState
  ): Promise<ToolOutcome> {
    const result = await this.host.execute({
      args,
      name: call.name,
      projectRoot: input.projectRoot,
      runId: input.runId,
      sessionId: input.sessionId,
      signal: input.signal
    });
    if (result.commandActivityId) {
      const command = {
        command: result.command ?? "",
        commandId: result.commandId,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        outputTruncated: result.outputTruncated,
        state: result.commandState
      };
      if (result.commandState === "running") {
        input.store.append({
          activityId: result.commandActivityId,
          data: { command },
          runId: result.commandRunId ?? input.runId,
          sessionId: result.commandSessionId ?? input.sessionId,
          type: "activity.updated"
        });
      } else {
        await this.settleManagedCommand(input, result.commandActivityId, result, false);
        workspaceMutationCoordinator.releaseCommand(result.commandId);
      }
    }
    const evidence = reduceToolEvidence(call.name, result);
    this.record(input, call, modelStepId, evidence.modelText, {
      action: prepared.action,
      commandId: result.commandId,
      commandState: result.commandState,
      target: prepared.normalizedTarget
    });
    return {
      contextRecords: [],
      message: { role: "tool", text: evidence.modelText, toolCallKey: call.callId },
      mutatedWorkspace: result.mutatedWorkspace,
      protocolError: false,
      target: prepared.normalizedTarget
    };
  }

  private async settleManagedCommand(
    input: ToolContext,
    activityId: string,
    result: import("../../shared/contracts/tool").ToolResult,
    releaseBaselineLease: boolean
  ): Promise<void> {
    try {
      const sessionId = result.commandSessionId ?? input.sessionId;
      const activity = input.store.getSession(sessionId)?.runs
        .flatMap((run) => run.activities)
        .find((item) => item.activityId === activityId);
      if (!activity || activity.status !== "running" || (activity.command?.state && activity.command.state !== "running")) return;
      input.store.append({
        activityId,
        data: {
          command: {
            command: result.command ?? activity.command?.command ?? "",
            commandId: result.commandId,
            elapsedMs: result.elapsedMs,
            exitCode: result.exitCode,
            outputTruncated: result.outputTruncated,
            state: result.commandState
          }
        },
        runId: activity.runId,
        sessionId,
        type: "activity.updated"
      });
      if (result.mutatedWorkspace) {
        const changes = await this.host.changes(input.projectRoot, input.baseline).catch(() => undefined);
        if (changes) {
          input.store.append({ data: changes, runId: activity.runId, sessionId, type: "changes.changed" });
        }
      }
      const status = result.commandState === "cancelled"
        ? "cancelled"
        : result.exitCode && result.exitCode !== 0 ? "failed" : "completed";
      const settled = finishActivity({ ...input, runId: activity.runId, sessionId }, activityId, {
        body: result.output,
        command: {
          command: result.command ?? activity.command?.command ?? "",
          commandId: result.commandId,
          elapsedMs: result.elapsedMs,
          exitCode: result.exitCode,
          outputTruncated: result.outputTruncated,
          state: result.commandState
        },
        status,
        tool: activity.tool ? { ...activity.tool, resultSummary: result.output.slice(0, 500) } : undefined
      });
      if (!settled) return;
      const evidence = reduceToolEvidence(activity.tool?.toolName ?? "run_command", result);
      input.store.appendContextEntry({
        kind: "context_update",
        metadata: { commandId: result.commandId, commandState: result.commandState, exitCode: result.exitCode },
        runId: activity.runId,
        sessionId,
        source: "runtime",
        text: `命令 ${result.commandId} 已结束。状态：${result.commandState}，退出码：${result.exitCode ?? "未知"}。\n${evidence.modelText}`
      });
    } finally {
      if (releaseBaselineLease) await this.host.close(input.baseline).catch(() => undefined);
    }
  }

  private record(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    text: string,
    metadata: Record<string, unknown>,
    isError = false
  ): void {
    input.store.appendContextEntry({
      isError,
      kind: "tool_result",
      metadata: { modelStepId, ...metadata },
      runId: input.runId,
      sessionId: input.sessionId,
      source: "tool",
      text,
      toolCallKey: call.callId,
      toolName: call.name
    });
  }

  private reject(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    activityId: string,
    prepared: ToolState,
    reason: string
  ): ToolOutcome {
    const text = `Runtime 拒绝了该操作：${reason}`;
    finishActivity(input, activityId, {
      body: prepared.toolName === "submit_plan" ? undefined : reason,
      error: reason,
      status: "failed",
      tool: { ...prepared, resultSummary: reason }
    });
    this.record(input, call, modelStepId, text, { action: prepared.action, policyDenied: true, target: prepared.normalizedTarget }, true);
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: prepared.normalizedTarget };
  }

}
