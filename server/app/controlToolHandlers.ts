import { ToolCall } from "../../shared/contracts/provider";
import { Plan, Question, QuestionPrompt, Task, ToolState } from "../../shared/contracts/runtime";
import { ToolHost } from "./toolHost";
import type { DelegateHandler, ToolContext, ToolOutcome } from "./toolPipeline";

type ControlToolCallbacks = {
  createId: (prefix: string) => string;
  finishActivity: (
    input: ToolContext,
    activityId: string,
    data: Parameters<typeof import("./activityLifecycle").finishActivity>[1]
  ) => boolean;
  record: (
    input: ToolContext,
    call: ToolCall,
    modelStepId: string,
    text: string,
    metadata: Record<string, unknown>,
    isError?: boolean
  ) => void;
  now: () => string;
};

function tasksFrom(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("执行任务至少需要一项。");
  const tasks = value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`执行任务第 ${index + 1} 项参数格式无效。`);
    const item = raw as Record<string, unknown>;
    const taskId = typeof item.taskId === "string" ? item.taskId.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const status = typeof item.status === "string" ? item.status as Task["status"] : undefined;
    if (!taskId) throw new Error(`执行任务第 ${index + 1} 项缺少必填参数 taskId。`);
    if (!label) throw new Error(`执行任务第 ${index + 1} 项缺少必填参数 label。必须在每次更新中提交完整的用户可读任务描述。`);
    if (!status || !["pending", "running", "completed", "blocked"].includes(status)) {
      throw new Error(`执行任务第 ${index + 1} 项 status 参数无效。`);
    }
    return {
      label,
      status,
      taskId
    };
  });
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error("执行任务的 taskId 参数必须唯一。");
  }
  if (tasks.filter((task) => task.status === "running").length > 1) {
    throw new Error("执行任务同时最多只能有一个 running 状态。");
  }
  return tasks;
}

export class ControlToolHandlers {
  constructor(
    private readonly host: ToolHost,
    private readonly callbacks: ControlToolCallbacks,
    private readonly delegateAgent?: DelegateHandler
  ) {}

  async handle(input: {
    activityId: string;
    args: Record<string, unknown>;
    argsSummary: string;
    call: ToolCall;
    context: ToolContext;
    modelStepId: string;
    prepared: ToolState;
  }): Promise<ToolOutcome | undefined> {
    switch (input.call.name) {
      case "enter_plan": return this.enterPlan(input);
      case "ask_user": return this.askUser(input);
      case "submit_plan": return this.submitPlan(input);
      case "update_tasks": return this.updateTasks(input);
      case "search_memory": return this.searchMemory(input);
      case "delegate":
      case "spawn_agent": return this.delegateTask(input);
      default: return undefined;
    }
  }

  private enterPlan(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, call, context, modelStepId, prepared } = input;
    const reason = String(args.reason ?? "").trim() || "当前工作需要先形成可审阅方案。";
    const session = context.store.getSession(context.sessionId)!;
    if (session.planEntry === "suggest") {
      const question: Question = {
        callId: call.callId,
        createdAt: this.callbacks.now(),
        interactionId: this.callbacks.createId("question"),
        prompts: [{
          label: "工作方式",
          options: ["进入计划模式", "继续工作模式"],
          prompt: reason,
          questionId: "plan_entry"
        }],
        purpose: "plan_entry",
        runId: context.runId,
        sessionId: context.sessionId,
        status: "pending"
      };
      context.store.append({ data: { question }, runId: context.runId, sessionId: context.sessionId, type: "question.asked" });
      this.callbacks.finishActivity(context, activityId, {
        body: "已建议进入计划模式，等待用户决定。",
        status: "completed",
        tool: { ...prepared, resultSummary: "等待用户决定是否进入计划模式" }
      });
      return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "计划模式" };
    }
    context.store.append({
      data: { mode: "plan" as const, previousMode: "work" as const, reason, source: "model" as const },
      runId: context.runId,
      sessionId: context.sessionId,
      type: "mode.changed"
    });
    const text = `已进入计划模式。原因：${reason}`;
    this.callbacks.finishActivity(context, activityId, { body: text, status: "completed", tool: { ...prepared, resultSummary: text } });
    this.callbacks.record(context, call, modelStepId, text, { action: "plan", mode: "plan", target: "计划模式" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "计划模式" };
  }

  private askUser(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, call, context, prepared } = input;
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
      createdAt: this.callbacks.now(),
      interactionId: this.callbacks.createId("question"),
      prompts,
      purpose: "clarification",
      runId: context.runId,
      sessionId: context.sessionId,
      status: "pending"
    };
    context.store.append({ data: { question }, runId: context.runId, sessionId: context.sessionId, type: "question.asked" });
    this.callbacks.finishActivity(context, activityId, {
      body: "等待用户回答方案问题。",
      status: "completed",
      tool: { ...prepared, resultSummary: "等待用户回答" }
    });
    return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "方案问题" };
  }

  private submitPlan(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, call, context, prepared } = input;
    const title = String(args.title ?? "").trim();
    const markdown = String(args.markdown ?? "").trim();
    if (!title || !markdown) throw new Error("方案标题和 Markdown 内容不能为空。");
    const existing = context.store.getSession(context.sessionId)?.plans
      .filter((plan) => plan.runId === context.runId)
      .sort((left, right) => right.revision - left.revision)[0];
    const at = this.callbacks.now();
    const plan: Plan = {
      callId: call.callId,
      createdAt: existing?.createdAt ?? at,
      markdown,
      planId: existing?.planId ?? this.callbacks.createId("plan"),
      revision: (existing?.revision ?? 0) + 1,
      runId: context.runId,
      sessionId: context.sessionId,
      status: "proposed",
      title,
      updatedAt: at
    };
    context.store.append({
      data: { plan },
      runId: context.runId,
      sessionId: context.sessionId,
      type: existing ? "plan.revised" : "plan.proposed"
    });
    this.callbacks.finishActivity(context, activityId, {
      body: markdown,
      status: "completed",
      tool: { ...prepared, resultSummary: "等待用户审阅" }
    });
    return { contextRecords: [], mutatedWorkspace: false, protocolError: false, suspended: true, target: "实施方案" };
  }

  private updateTasks(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, argsSummary, call, context, modelStepId } = input;
    const tasks = tasksFrom(args.tasks);
    context.store.append({ data: { items: tasks }, runId: context.runId, sessionId: context.sessionId, type: "tasks.changed" });
    const text = "执行任务已更新。";
    this.callbacks.finishActivity(context, activityId, {
      body: text,
      status: "completed",
      tool: this.host.prepare({
        args,
        argumentsPreview: argsSummary,
        callId: call.callId,
        modelStepId,
        name: call.name,
        output: text,
        projectRoot: context.projectRoot,
        result: { mutatedWorkspace: false, output: text }
      })
    });
    this.callbacks.record(context, call, modelStepId, text, { action: "task", target: "执行任务" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "执行任务" };
  }

  private searchMemory(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, call, context, modelStepId, prepared } = input;
    const query = String(args.query ?? "").trim().toLowerCase();
    const limit = Math.min(20, Math.max(1, Number(args.limit ?? 10)));
    const facts = context.store.readMemories(context.projectRoot)
      .filter((fact) => !query || `${fact.category} ${fact.statement} ${fact.provenance}`.toLowerCase().includes(query))
      .slice(0, limit);
    const text = JSON.stringify({ facts });
    const summary = `已读取 ${facts.length} 条受控记忆。`;
    this.callbacks.finishActivity(context, activityId, { body: summary, status: "completed", tool: { ...prepared, resultSummary: summary } });
    this.callbacks.record(context, call, modelStepId, text, { action: "search", target: "Memory" });
    return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false, target: "Memory" };
  }

  private delegateTask(input: Parameters<ControlToolHandlers["handle"]>[0]): ToolOutcome {
    const { activityId, args, call, context, modelStepId, prepared } = input;
    if (!this.delegateAgent) {
      const text = "delegate 需要运行时委派协调器，当前环境不支持子代理。";
      this.callbacks.finishActivity(context, activityId, { body: text, status: "failed", tool: { ...prepared, resultSummary: text } });
      this.callbacks.record(context, call, modelStepId, text, { action: "execute", target: "子 Agent" }, true);
      return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false };
    }
    const requestedAgent = args.agent ?? args.subagent_type;
    const agent = requestedAgent === "explorer" || requestedAgent === "Explore"
      ? "explorer"
      : requestedAgent === "worker" || requestedAgent === "general-purpose" ? "worker" : undefined;
    const message = String(args.message ?? args.prompt ?? "").trim();
    if (!agent || !message) {
      const text = "agent 必须是 explorer 或 worker，message 不能为空。";
      this.callbacks.finishActivity(context, activityId, { body: text, status: "failed", tool: { ...prepared, resultSummary: text } });
      this.callbacks.record(context, call, modelStepId, text, { action: "execute", target: "子代理" }, true);
      return { contextRecords: [], message: { role: "tool", text, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false };
    }
    try {
      const receipt = this.delegateAgent({ activityId, agent, callId: call.callId, message });
      const output = JSON.stringify(receipt);
      const summary = `已委派给 ${agent}`;
      this.callbacks.finishActivity(context, activityId, { body: summary, status: "completed", tool: { ...prepared, resultSummary: summary } });
      this.callbacks.record(context, call, modelStepId, output, { action: "execute", delegationId: receipt.delegationId, target: `${agent}: ${message}` });
      return { contextRecords: [], message: { role: "tool", text: output, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false };
    } catch (error) {
      const output = `委派失败：${error instanceof Error ? error.message : String(error)}`;
      this.callbacks.finishActivity(context, activityId, { body: output, status: "failed", tool: { ...prepared, resultSummary: output } });
      this.callbacks.record(context, call, modelStepId, output, { action: "execute", target: `${agent}: ${message}` }, true);
      return { contextRecords: [], message: { role: "tool", text: output, toolCallKey: call.callId }, mutatedWorkspace: false, protocolError: false };
    }
  }
}
