import { Run, ResumeState } from "../../shared/contracts/runtime";
import { MissingToolResult, missingToolResults } from "../../shared/domain/toolProtocol";
import type { RuntimeRepo } from "./runtimeRepo";

function recoveryFor(input: {
  run: Run;
  plan?: ResumeState["plan"];
  failureMessage: string;
  failureType: ResumeState["failureType"];
  projectRoot: string;
  finishedAt: string;
}): ResumeState {
  const completedOperations = input.run.activities
    .filter((activity) => activity.status === "completed" && activity.kind !== "thinking")
    .map((activity) => activity.tool?.resultSummary || activity.body || activity.title)
    .filter(Boolean)
    .slice(-24);
  const interruptedOperations = input.run.activities
    .filter((activity) => activity.status === "running")
    .map((activity) => activity.tool?.displayTarget || activity.title)
    .filter(Boolean);
  const lastProgress = [...input.run.activities]
    .reverse()
    .find((activity) => activity.kind === "message" && activity.body.trim())
    ?.body.trim();
  return {
    capturedAt: input.finishedAt,
    changedFiles: input.run.changes.files.map((file) => file.path),
    completedOperations,
    failureMessage: input.failureMessage,
    failureType: input.failureType,
    interruptedOperations,
    lastProgress,
    mode: input.run.mode,
    plan: input.plan,
    tasks: input.run.tasks,
    projectRoot: input.projectRoot
  };
}

export function appendInterruptedToolResults(input: {
  createdAt?: string;
  interruptionReason: string;
  missingResults: MissingToolResult[];
  runId: string;
  sessionId: string;
  store: RuntimeRepo;
  terminalPhase: "completed" | "failed" | "cancelled";
}): number {
  const createdAt = input.createdAt ?? new Date().toISOString();
  for (const { assistant, call } of input.missingResults) {
    input.store.appendContextEntry({
      createdAt,
      isError: true,
      kind: "tool_result",
      metadata: {
        assistantRecordId: assistant.recordId,
        interruptionReason: input.interruptionReason,
        synthetic: true,
        terminalPhase: input.terminalPhase
      },
      runId: input.runId,
      sessionId: input.sessionId,
      source: "runtime",
      text: `工具调用 ${call.name} (${call.callId}) 已中断：${input.interruptionReason}。该结果仅用于闭合工具协议，不能视为工具执行成功。`,
      toolCallKey: call.callId,
      toolName: call.name
    });
  }
  return input.missingResults.length;
}

export function finishRun(input: {
  runId: string;
  error?: string;
  failureType?: ResumeState["failureType"];
  answer: string;
  status: "completed" | "failed" | "cancelled";
  projectRoot: string;
  sessionId: string;
  store: RuntimeRepo;
}): void {
  const finishedAt = new Date().toISOString();
  let run = input.store.getRun(input.runId);
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;

  let contextRecords = input.store.readContextEntries(input.sessionId)
    .filter((record) => record.runId === input.runId);
  const missingResults = missingToolResults(contextRecords);
  const status = input.status === "completed" && missingResults.length > 0 ? "failed" : input.status;
  const error = input.status === "completed" && missingResults.length > 0
    ? `Runtime 检测到 ${missingResults.length} 个工具调用缺少结果，已阻止本次运行以完成状态结束。`
    : input.error;
  const interruptionReason = input.status === "cancelled"
    ? "用户中止了本次运行"
    : input.status === "failed"
      ? (input.error || "本次运行异常结束")
      : "本次运行在工具协议尚未闭合时结束";

  appendInterruptedToolResults({
    createdAt: finishedAt,
    interruptionReason,
    missingResults,
    runId: input.runId,
    sessionId: input.sessionId,
    store: input.store,
    terminalPhase: status
  });

  for (const activity of run.activities.filter((item) => item.status === "running" || item.status === "suspended")) {
    input.store.append({
      runId: input.runId,
      data: {
        body: error || activity.body,
        error,
        status: status === "cancelled" ? "cancelled" as const : status === "failed" ? "failed" as const : "completed" as const,
        finishedAt: finishedAt
      },
      sessionId: input.sessionId,
      type: "activity.finished",
      activityId: activity.activityId
    });
  }

  run = input.store.getRun(input.runId)!;
  for (const approval of run.approvals.filter((item) => item.state === "pending")) {
    input.store.append({
      runId: input.runId,
      data: { approvalId: approval.approvalId, state: "dismissed" as const },
      sessionId: input.sessionId,
      type: "approval.resolved"
    });
  }

  run = input.store.getRun(input.runId)!;
  const resume = status === "completed" || !error
    ? undefined
    : recoveryFor({
        run,
        plan: input.store.getSession(input.sessionId)?.plans
          .filter((plan) => plan.runId === input.runId)
          .sort((left, right) => right.revision - left.revision)[0],
        failureMessage: error,
        failureType: input.failureType ?? (status === "cancelled" ? "cancelled" : "runtime_error"),
        projectRoot: input.projectRoot,
        finishedAt
      });
  contextRecords = input.store.readContextEntries(input.sessionId)
    .filter((record) => record.runId === input.runId);
  if (!contextRecords.some((record) => record.kind === "human_text")) {
    input.store.appendContextEntry({
      createdAt: run.startedAt,
      runId: input.runId,
      kind: "human_text",
      sessionId: input.sessionId,
      source: "runtime",
      text: run.prompt
    });
  }
  if (!contextRecords.some((record) => record.kind === "agent_text")) {
    input.store.appendContextEntry({
      createdAt: finishedAt,
      runId: input.runId,
      isError: status !== "completed",
      kind: "agent_text",
      metadata: { terminalPhase: status },
      sessionId: input.sessionId,
      source: "runtime",
      text: input.answer
    });
  }
  if (resume) {
    input.store.appendContextEntry({
      createdAt: finishedAt,
      runId: input.runId,
      isError: true,
      kind: "recovery_capsule",
      metadata: { factKind: "resume" },
      sessionId: input.sessionId,
      source: "runtime",
      text: `上一运行未完成：${JSON.stringify(resume)}`
    });
  }
  input.store.append({
    runId: input.runId,
    data: {
      error,
      answer: input.answer,
      status,
      resume,
      finishedAt
    },
    sessionId: input.sessionId,
    type: "run.finished"
  });
}
