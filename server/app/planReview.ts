import { AccessMode, PlanDecision, Session } from "../../shared/contracts/runtime";
import { ModelProtocol } from "../../shared/contracts/provider";
import { ContextPort, EventInput, EventPort, SessionPort } from "./runtimeRepo";
import { AppError, AppErrorCode } from "./appError";
import { SystemPort } from "./systemPort";

type PlanReviewPorts = ContextPort & EventPort & SessionPort;

export class PlanReviewError extends AppError {
  constructor(message: string, code: AppErrorCode) {
    super(message, code);
    this.name = "PlanReviewError";
  }
}

export type ResumeRun = {
  model: string;
  protocol: ModelProtocol;
  projectRoot: string;
  prompt: string;
  runId: string;
  sessionId: string;
};

export type ReviewResult = {
  idempotent: boolean;
  resume?: ResumeRun;
  session: Session;
};

function resultText(input: {
  accessMode?: AccessMode;
  comments?: string;
  decision: PlanDecision;
  planId: string;
  revision: number;
}): string {
  return JSON.stringify({
    accessMode: input.accessMode,
    comments: input.comments?.trim() || undefined,
    decision: input.decision,
    planId: input.planId,
    revision: input.revision
  });
}

function resumeFor(session: Session, runId: string): ResumeRun {
  const run = session.runs.find((item) => item.runId === runId);
  if (!run) throw new PlanReviewError("Plan Run not found.", "not_found");
  return { model: run.model, protocol: run.protocol ?? "chat", projectRoot: session.projectRoot, prompt: run.prompt, runId, sessionId: session.sessionId };
}

export function resolvePlan(input: {
  accessMode?: AccessMode;
  comments?: string;
  decision: PlanDecision;
  planId: string;
  revision: number;
  sessionId: string;
  store: PlanReviewPorts;
  system: SystemPort;
}): ReviewResult {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new PlanReviewError("Session not found.", "not_found");
  const plan = session.plans.find((item) => item.planId === input.planId && item.revision === input.revision);
  if (!plan) throw new PlanReviewError("Plan revision not found.", "not_found");
  if (plan.status !== "proposed") {
    const decisionEvent = [...input.store.readEvents(input.sessionId)].reverse().find((event) => {
      if (event.type !== "plan.approved" && event.type !== "plan.rejected") return false;
      const data = event.data as { decision?: PlanDecision; planId?: string; revision?: number };
      return data.planId === plan.planId && data.revision === plan.revision;
    });
    const sameDecision = decisionEvent?.type === "plan.approved"
      ? input.decision === "start_work"
      : decisionEvent?.type === "plan.rejected" && (decisionEvent.data as { decision?: PlanDecision }).decision === input.decision;
    if (!sameDecision) throw new PlanReviewError("Plan revision is stale.", "stale_revision");
    return { idempotent: true, session };
  }
  const run = session.runs.find((item) => item.runId === plan.runId);
  if (!run || run.status !== "waiting") throw new PlanReviewError("Plan Run is not waiting for review.", "not_waiting");
  const resolvedAt = input.system.now();
  const events: EventInput[] = [];
  if (input.decision === "start_work") {
    if (input.accessMode && input.accessMode !== session.accessMode) {
      events.push({ data: { accessMode: input.accessMode }, sessionId: session.sessionId, type: "session.updated" });
    }
    events.push({
      data: { approvedAt: resolvedAt, planId: plan.planId, revision: plan.revision },
      runId: run.runId,
      sessionId: session.sessionId,
      type: "plan.approved"
    });
    events.push({
      data: { mode: "work", previousMode: "plan", reason: "用户批准实施方案。", source: "user" },
      runId: run.runId,
      sessionId: session.sessionId,
      type: "mode.changed"
    });
  } else {
    events.push({
      data: { comments: input.comments?.trim() || undefined, decision: input.decision, planId: plan.planId, resolvedAt, revision: plan.revision },
      runId: run.runId,
      sessionId: session.sessionId,
      type: "plan.rejected"
    });
    if (input.decision === "cancel") {
      events.push({
        data: { mode: "work", previousMode: "plan", reason: "用户取消了当前方案。", source: "user" },
        runId: run.runId,
        sessionId: session.sessionId,
        type: "mode.changed"
      });
      events.push({
        data: { answer: "计划已取消。", finishedAt: resolvedAt, status: "cancelled" },
        runId: run.runId,
        sessionId: session.sessionId,
        type: "run.finished"
      });
    }
  }
  input.store.appendMany(events);
  input.store.appendContextEntry({
    isError: input.decision === "cancel",
    kind: "tool_result",
    metadata: { decision: input.decision, planId: plan.planId, revision: plan.revision },
    runId: run.runId,
    sessionId: session.sessionId,
    source: "runtime",
    text: resultText(input),
    toolCallKey: plan.callId,
    toolName: "submit_plan"
  });
  const next = input.store.getSession(session.sessionId)!;
  return {
    idempotent: false,
    resume: input.decision === "cancel" ? undefined : resumeFor(next, run.runId),
    session: next
  };
}

export function answerQuestion(input: {
  answers: Record<string, string>;
  interactionId: string;
  sessionId: string;
  store: PlanReviewPorts;
  system: SystemPort;
}): ReviewResult {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new PlanReviewError("Session not found.", "not_found");
  const question = session.questions.find((item) => item.interactionId === input.interactionId);
  if (!question) throw new PlanReviewError("Question interaction not found.", "not_found");
  const answers = Object.fromEntries(question.prompts.map((prompt) => {
    const answer = String(input.answers[prompt.questionId] ?? "").trim();
    if (!answer) throw new PlanReviewError(`Question ${prompt.questionId} requires an answer.`, "invalid_input");
    return [prompt.questionId, answer];
  }));
  if (question.status === "answered") {
    if (JSON.stringify(question.answers ?? {}) !== JSON.stringify(answers)) throw new PlanReviewError("Question interaction is stale.", "stale_revision");
    return { idempotent: true, session };
  }
  if (question.status !== "pending") throw new PlanReviewError("Question interaction is stale.", "stale_revision");
  const resolvedAt = input.system.now();
  const enterPlan = question.purpose === "plan_entry" && answers.plan_entry === "进入计划模式";
  const events: EventInput[] = [{
    data: { answers, interactionId: question.interactionId, resolvedAt, status: "answered" },
    runId: question.runId,
    sessionId: session.sessionId,
    type: "question.answered"
  }];
  if (enterPlan) {
    events.push({
      data: { mode: "plan", previousMode: session.mode, reason: "用户接受了模型的计划模式建议。", source: "user" },
      runId: question.runId,
      sessionId: session.sessionId,
      type: "mode.changed"
    });
  }
  input.store.appendMany(events);
  input.store.appendContextEntry({
    kind: "tool_result",
    metadata: { interactionId: question.interactionId },
    runId: question.runId,
    sessionId: session.sessionId,
    source: "runtime",
    text: JSON.stringify({ answers, interactionId: question.interactionId, mode: enterPlan ? "plan" : session.mode }),
    toolCallKey: question.callId,
    toolName: "ask_user"
  });
  const next = input.store.getSession(session.sessionId)!;
  return { idempotent: false, resume: resumeFor(next, question.runId), session: next };
}

export function revisePlan(input: {
  markdown: string;
  planId: string;
  revision: number;
  sessionId: string;
  store: PlanReviewPorts;
  system: SystemPort;
  title: string;
}): Session {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new PlanReviewError("Session not found.", "not_found");
  const plan = session.plans.find((item) => item.planId === input.planId && item.revision === input.revision);
  if (!plan) throw new PlanReviewError("Plan revision not found.", "not_found");
  if (plan.status !== "proposed") throw new PlanReviewError("Plan revision is stale.", "stale_revision");
  const title = input.title.trim();
  const markdown = input.markdown.trim();
  if (!title || !markdown) throw new PlanReviewError("Plan title and Markdown are required.", "invalid_input");
  if (title === plan.title && markdown === plan.markdown) return session;
  const updatedAt = input.system.now();
  input.store.append({
    data: {
      plan: {
        ...plan,
        markdown,
        revision: plan.revision + 1,
        status: "proposed" as const,
        title,
        updatedAt
      }
    },
    runId: plan.runId,
    sessionId: session.sessionId,
    type: "plan.revised"
  });
  return input.store.getSession(session.sessionId)!;
}
