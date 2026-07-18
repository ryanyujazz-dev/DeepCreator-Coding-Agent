import { Run, ResumeState } from "../../shared/contracts/runtime";
import type { RuntimeRepo } from "./runtimeRepo";

function recoveryFor(input: {
  run: Run;
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
    plan: input.run.plan,
    projectRoot: input.projectRoot
  };
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

  for (const activity of run.activities.filter((item) => item.status === "running")) {
    input.store.append({
      runId: input.runId,
      data: {
        body: input.error || activity.body,
        error: input.error,
        status: input.status === "cancelled" ? "cancelled" as const : input.status === "failed" ? "failed" as const : "completed" as const,
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
  const resume = input.status === "completed" || !input.error
    ? undefined
    : recoveryFor({
        run,
        failureMessage: input.error,
        failureType: input.failureType ?? (input.status === "cancelled" ? "cancelled" : "runtime_error"),
        projectRoot: input.projectRoot,
        finishedAt
      });
  const contextRecords = input.store.readContextEntries(input.sessionId)
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
      isError: input.status !== "completed",
      kind: "agent_text",
      metadata: { terminalPhase: input.status },
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
      error: input.error,
      answer: input.answer,
      status: input.status,
      resume,
      finishedAt
    },
    sessionId: input.sessionId,
    type: "run.finished"
  });
}
