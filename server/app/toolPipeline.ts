import { randomUUID } from "node:crypto";
import { ContextInput } from "../../shared/contracts/context";
import { ModelMessage, ToolCall } from "../../shared/contracts/provider";
import { Plan, Question, QuestionPrompt, Task, ToolState } from "../../shared/contracts/runtime";
import { Baseline } from "../../shared/contracts/tool";
import { emptyRuleSource, RuleSource } from "../../shared/contracts/rules";
import { approvalFor } from "../domain/accessPolicy";
import { reduceToolEvidence } from "../domain/evidence";
import { hasConflictingControlStep, planPolicy } from "../domain/planPolicy";
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

function tasksFrom(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("执行任务至少需要一项。");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("执行任务格式无效。");
    const item = raw as Record<string, unknown>;
    const status = String(item.status ?? "pending") as Task["status"];
    if (!["pending", "running", "completed", "blocked"].includes(status)) throw new Error("执行任务状态无效。");
    return { label: String(item.label ?? item.taskId ?? "未命名任务"), status, taskId: String(item.taskId ?? randomUUID()) };
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
    stepRejection?: string
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

      const session = input.store.getSession(input.sessionId)!;
      if (stepRejection) return this.reject(input, call, modelStepId, activityId, prepared, stepRejection);
      if (call.name === "enter_plan" && input.store.getRun(input.runId)?.changes.fileCount) {
        return this.reject(input, call, modelStepId, activityId, prepared, "当前运行已经修改工作区，不能再进入计划模式。");
      }
      const policy = planPolicy({ args, mode: session.mode, planEntry: session.planEntry, tool: prepared });
      if (!policy.allowed) return this.reject(input, call, modelStepId, activityId, prepared, policy.reason ?? "当前模式不允许该操作。");

      if (call.name === "enter_plan") return this.enterPlan(input, call, modelStepId, activityId, args, prepared);
      if (call.name === "ask_user") return this.askUser(input, call, modelStepId, activityId, args, prepared);
      if (call.name === "submit_plan") return this.submitPlan(input, call, modelStepId, activityId, args, prepared);
      if (call.name === "update_tasks") return this.updateTasks(input, call, modelStepId, activityId, args, argsSummary);
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
          input.store.append({ activityId, data: { bodyDelta: text }, runId: input.runId, sessionId: input.sessionId, type: "activity.updated" });
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
      body: reason,
      error: reason,
      status: "failed",
      tool: { ...prepared, resultSummary: reason }
    });
    this.record(input, call, modelStepId, text, { action: prepared.action, policyDenied: true, target: prepared.normalizedTarget }, true);
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: prepared.normalizedTarget };
  }

  private enterPlan(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    prepared: ToolState
  ): ToolOutcome {
    const reason = String(args.reason ?? "").trim() || "当前工作需要先形成可审阅方案。";
    const session = input.store.getSession(input.sessionId)!;
    if (session.planEntry === "suggest") {
      const question: Question = {
        callId: call.callId,
        createdAt: new Date().toISOString(),
        interactionId: `question_${randomUUID()}`,
        prompts: [{
          label: "工作方式",
          options: ["进入计划模式", "继续工作模式"],
          prompt: reason,
          questionId: "plan_entry"
        }],
        purpose: "plan_entry",
        runId: input.runId,
        sessionId: input.sessionId,
        status: "pending"
      };
      input.store.append({ data: { question }, runId: input.runId, sessionId: input.sessionId, type: "question.asked" });
      finishActivity(input, activityId, { body: "已建议进入计划模式，等待用户决定。", status: "completed", tool: { ...prepared, resultSummary: "等待用户决定是否进入计划模式" } });
      return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "计划模式" };
    }
    input.store.append({
      data: { mode: "plan" as const, previousMode: "work" as const, reason, source: "model" as const },
      runId: input.runId,
      sessionId: input.sessionId,
      type: "mode.changed"
    });
    const text = `已进入计划模式。原因：${reason}`;
    finishActivity(input, activityId, { body: text, status: "completed", tool: { ...prepared, resultSummary: text } });
    this.record(input, call, modelStepId, text, { action: "plan", mode: "plan", target: "计划模式" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "计划模式" };
  }

  private askUser(
    input: ToolContext,
    call: ToolCall,
    _modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    prepared: ToolState
  ): ToolOutcome {
    if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
      throw new Error("ask_user 需要一至三个问题。");
    }
    const prompts = args.questions.map((raw, index): QuestionPrompt => {
      if (!raw || typeof raw !== "object") throw new Error("问题格式无效。");
      const item = raw as Record<string, unknown>;
      const prompt = String(item.prompt ?? "").trim();
      if (!prompt) throw new Error("问题内容不能为空。");
      const options = Array.isArray(item.options) ? item.options.map(String).filter(Boolean).slice(0, 3) : undefined;
      return {
        label: String(item.label ?? `问题 ${index + 1}`).trim(),
        options: options && options.length >= 2 ? options : undefined,
        prompt,
        questionId: String(item.questionId ?? `question_${index + 1}`)
      };
    });
    const question: Question = {
      callId: call.callId,
      createdAt: new Date().toISOString(),
      interactionId: `question_${randomUUID()}`,
      prompts,
      purpose: "clarification",
      runId: input.runId,
      sessionId: input.sessionId,
      status: "pending"
    };
    input.store.append({ data: { question }, runId: input.runId, sessionId: input.sessionId, type: "question.asked" });
    finishActivity(input, activityId, { body: "等待用户回答方案问题。", status: "completed", tool: { ...prepared, resultSummary: "等待用户回答" } });
    return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "方案问题" };
  }

  private submitPlan(
    input: ToolContext,
    call: ToolCall,
    _modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    prepared: ToolState
  ): ToolOutcome {
    const title = String(args.title ?? "").trim();
    const markdown = String(args.markdown ?? "").trim();
    if (!title || !markdown) throw new Error("方案标题和 Markdown 内容不能为空。");
    const existing = input.store.getSession(input.sessionId)?.plans
      .filter((plan) => plan.runId === input.runId)
      .sort((left, right) => right.revision - left.revision)[0];
    const at = new Date().toISOString();
    const plan: Plan = {
      callId: call.callId,
      createdAt: existing?.createdAt ?? at,
      markdown,
      planId: existing?.planId ?? `plan_${randomUUID()}`,
      revision: (existing?.revision ?? 0) + 1,
      runId: input.runId,
      sessionId: input.sessionId,
      status: "proposed",
      title,
      updatedAt: at
    };
    input.store.append({
      data: { plan },
      runId: input.runId,
      sessionId: input.sessionId,
      type: existing ? "plan.revised" : "plan.proposed"
    });
    finishActivity(input, activityId, { body: "方案已提交，等待用户审阅。", status: "completed", tool: { ...prepared, resultSummary: "等待用户审阅" } });
    return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "实施方案" };
  }

  private updateTasks(
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    activityId: string,
    args: Record<string, unknown>,
    argsSummary: string
  ): ToolOutcome {
    const tasks = tasksFrom(args.tasks);
    input.store.append({ data: { items: tasks }, runId: input.runId, sessionId: input.sessionId, type: "tasks.changed" });
    const text = "执行任务已更新。";
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
    this.record(input, call, modelStepId, text, { action: "task", target: "执行任务" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "执行任务" };
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
