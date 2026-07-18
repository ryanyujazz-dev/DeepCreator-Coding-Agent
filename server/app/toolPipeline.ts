import { randomUUID } from "node:crypto";
import { ContextInput } from "../../shared/contracts/context";
import { ModelMessage, ToolCall } from "../../shared/contracts/provider";
import { PlanItem } from "../../shared/contracts/runtime";
import { Baseline } from "../../shared/contracts/tool";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import { approvalFor } from "../domain/accessPolicy";
import { reduceToolEvidence } from "../domain/evidence";
import { contextUpdateRecord, findNewPathInstructions } from "./contextBuilder";
import { RunRegistry } from "./runRegistry";
import { RuntimeRepo } from "./runtimeRepo";
import { ToolHost } from "./toolHost";

export type ToolContext = {
  baseline: Baseline;
  projectRoot: string;
  registry: RunRegistry;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  store: RuntimeRepo;
};

export type ToolOutcome = {
  contextRecords: ContextInput[];
  message: ModelMessage;
  mutatedWorkspace: boolean;
  protocolError: boolean;
  target?: string;
};

function parseArgs(text: string): Record<string, unknown> {
  try {
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("工具参数不是有效的 JSON。");
  }
}

function planFrom(value: unknown): PlanItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("计划至少需要一个步骤。");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("计划步骤格式无效。");
    const item = raw as Record<string, unknown>;
    const status = String(item.status ?? "pending") as PlanItem["status"];
    if (!["pending", "running", "completed", "blocked"].includes(status)) throw new Error("计划状态无效。");
    return { label: String(item.label ?? item.stepId ?? "未命名步骤"), status, stepId: String(item.stepId ?? randomUUID()) };
  });
}

function openActivity(input: ToolContext, data: Record<string, unknown>, activityId = `activity_${randomUUID()}`): string {
  input.store.append({ activityId, data, runId: input.runId, sessionId: input.sessionId, type: "activity.started" });
  return activityId;
}

function finishActivity(input: ToolContext, activityId: string, data: Record<string, unknown>): void {
  input.store.append({
    activityId,
    data: { ...data, finishedAt: new Date().toISOString() },
    runId: input.runId,
    sessionId: input.sessionId,
    type: "activity.finished"
  });
}

export class ToolPipeline {
  constructor(
    private readonly host: ToolHost,
    private readonly rules: RuleSource = emptyRuleSource
  ) {}

  async run(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    knownRuleIds: Set<string>,
    existingActivityId?: string
  ): Promise<ToolOutcome> {
    let activityId = existingActivityId;
    try {
      // normalize
      const args = parseArgs(call.argumentsText);
      const argsSummary = this.host.summarizeArgs(call.name, args);

      // validate
      if (!this.host.has(call.name)) throw new Error(`未知工具：${call.name}。可用工具：${this.host.names().join(", ")}`);
      const title = this.host.title(call.name);
      const prepared = this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        projectRoot: input.projectRoot
      });
      activityId ??= openActivity(input, {
        audience: "user",
        kind: this.host.kind(prepared),
        startedAt: new Date().toISOString(),
        title,
        tool: prepared
      });
      if (existingActivityId) {
        input.store.append({
          activityId,
          data: { kind: this.host.kind(prepared), title, tool: prepared },
          runId: input.runId,
          sessionId: input.sessionId,
          type: "activity.updated"
        });
      }

      if (call.name === "update_plan") return this.updatePlan(input, call, modelStepId, activityId, args, argsSummary);
      if (call.name === "search_memory") return this.searchMemory(input, call, modelStepId, activityId, args, prepared);

      const target = prepared.normalizedTarget;
      const preflight = ["write_file", "edit_file", "delete_file"].includes(call.name) && target
        ? findNewPathInstructions(input.projectRoot, [target], knownRuleIds, this.rules)
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

      // authorize
      const session = input.store.getSession(input.sessionId)!;
      const approval = approvalFor({ args, grants: session.grants, profile: session.accessMode, runId: input.runId, toolName: call.name });
      if (approval) {
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
          const text = "用户拒绝了本次操作，请不要再次尝试同一操作。";
          finishActivity(input, activityId, { body: "用户拒绝了本次操作。", status: "cancelled", tool: { ...prepared, resultSummary: "用户拒绝了本次操作。" } });
          this.record(input, call, modelStepId, text, { action: prepared.action, target: prepared.normalizedTarget }, true);
          return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target };
        }
      }

      // checkpoint
      if (["write_file", "edit_file", "delete_file"].includes(call.name)) {
        await this.host.checkpoint(input.projectRoot, input.baseline, String(args.path ?? ""));
      }

      // execute
      const result = await this.host.execute({
        args,
        name: call.name,
        onOutput: call.name === "run_command" ? ({ text }) => {
          input.store.append({ activityId, data: { text }, runId: input.runId, sessionId: input.sessionId, type: "activity.updated" });
        } : undefined,
        projectRoot: input.projectRoot,
        signal: input.signal
      });

      // record
      const completed = this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        output: result.output,
        projectRoot: input.projectRoot,
        result
      });
      finishActivity(input, activityId, {
        body: this.host.summarizeResult(call.name, args, result.output),
        command: result.command ? { command: result.command, exitCode: result.exitCode, timedOut: result.timedOut } : undefined,
        status: result.exitCode && result.exitCode !== 0 ? "failed" : "completed",
        tool: completed
      });
      const evidence = reduceToolEvidence(call.name, result);
      const recordId = `context_${randomUUID()}`;
      input.store.appendContextEntry({
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
      });
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
        message: { role: "tool", text: evidence.modelText, toolCallKey: call.callId },
        mutatedWorkspace: result.mutatedWorkspace,
        protocolError: false,
        target: completed.normalizedTarget
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activityId ??= openActivity(input, {
        audience: "user",
        body: "",
        kind: "tool",
        startedAt: new Date().toISOString(),
        title: `工具调用失败：${call.name || "未知工具"}`
      });
      finishActivity(input, activityId, { body: message, error: message, status: "failed" });
      const text = `工具执行失败：${message}`;
      this.record(input, call, modelStepId, text, { action: "execute", target: call.name || "未知工具" }, true);
      return {
        contextRecords: [],
        message: { role: "tool", text, toolCallKey: call.callId },
        mutatedWorkspace: false,
        protocolError: /未知工具|有效的 JSON|格式无效|参数/.test(message),
        target: call.name
      };
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

  private updatePlan(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    argsSummary: string
  ): ToolOutcome {
    const steps = planFrom(args.steps);
    input.store.append({ data: { items: steps }, runId: input.runId, sessionId: input.sessionId, type: "plan.changed" });
    const text = "计划已更新。";
    finishActivity(input, activityId, {
      body: text,
      status: "completed",
      tool: this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        output: text,
        projectRoot: input.projectRoot,
        result: { mutatedWorkspace: false, output: text }
      })
    });
    this.record(input, call, modelStepId, text, { action: "plan", target: "当前计划" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "当前计划" };
  }

  private searchMemory(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    prepared: ReturnType<ToolHost["prepare"]>
  ): ToolOutcome {
    const query = String(args.query ?? "").trim().toLowerCase();
    const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10)));
    const facts = input.store.readMemories(input.projectRoot)
      .filter((fact) => !query || `${fact.category} ${fact.statement} ${fact.provenance}`.toLowerCase().includes(query))
      .slice(0, limit);
    const text = JSON.stringify({ facts });
    const summary = `已读取 ${facts.length} 条受控记忆。`;
    finishActivity(input, activityId, { body: summary, status: "completed", tool: { ...prepared, resultSummary: summary } });
    this.record(input, call, modelStepId, text, { action: "search", target: "Memory" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "Memory" };
  }
}
