import { AccessMode, PlanDecision, Session } from "../../shared/contracts/runtime";
import { RuntimeRepo } from "./runtimeRepo";

export type ResumeRun = {
  model: string;
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
  if (!run) throw new Error("Plan Run not found.");
  return { model: run.model, projectRoot: session.projectRoot, prompt: run.prompt, runId, sessionId: session.sessionId };
}

export function resolvePlan(input: {
  accessMode?: AccessMode;
  comments?: string;
  decision: PlanDecision;
  planId: string;
  revision: number;
  sessionId: string;
  store: RuntimeRepo;
}): ReviewResult {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session not found.");
  const plan = session.plans.find((item) => item.planId === input.planId && item.revision === input.revision);
  if (!plan) throw new Error("Plan revision not found.");
  if (plan.status !== "proposed") {
    const decisionEvent = [...input.store.readEvents(input.sessionId)].reverse().find((event) => {
      if (event.type !== "plan.approved" && event.type !== "plan.rejected") return false;
      const data = event.data as { decision?: PlanDecision; planId?: string; revision?: number };
      return data.planId === plan.planId && data.revision === plan.revision;
    });
    const sameDecision = decisionEvent?.type === "plan.approved"
      ? input.decision === "start_work"
      : decisionEvent?.type === "plan.rejected" && (decisionEvent.data as { decision?: PlanDecision }).decision === input.decision;
    if (!sameDecision) throw new Error("Plan revision is stale.");
    return { idempotent: true, session };
  }
  const run = session.runs.find((item) => item.runId === plan.runId);
  if (!run || run.status !== "waiting") throw new Error("Plan Run is not waiting for review.");
  const resolvedAt = new Date().toISOString();
  const events: Parameters<RuntimeRepo["appendMany"]>[0] = [];
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
  store: RuntimeRepo;
}): ReviewResult {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session not found.");
  const question = session.questions.find((item) => item.interactionId === input.interactionId);
  if (!question) throw new Error("Question interaction not found.");
  const answers = Object.fromEntries(question.prompts.map((prompt) => {
    const answer = String(input.answers[prompt.questionId] ?? "").trim();
    if (!answer) throw new Error(`Question ${prompt.questionId} requires an answer.`);
    return [prompt.questionId, answer];
  }));
  if (question.status === "answered") {
    if (JSON.stringify(question.answers ?? {}) !== JSON.stringify(answers)) throw new Error("Question interaction is stale.");
    return { idempotent: true, session };
  }
  if (question.status !== "pending") throw new Error("Question interaction is stale.");
  const resolvedAt = new Date().toISOString();
  const enterPlan = question.purpose === "plan_entry" && answers.plan_entry === "进入计划模式";
  const events: Parameters<RuntimeRepo["appendMany"]>[0] = [{
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
  store: RuntimeRepo;
  title: string;
}): Session {
  const session = input.store.getSession(input.sessionId);
  if (!session) throw new Error("Session not found.");
  const plan = session.plans.find((item) => item.planId === input.planId && item.revision === input.revision);
  if (!plan) throw new Error("Plan revision not found.");
  if (plan.status !== "proposed") throw new Error("Plan revision is stale.");
  const title = input.title.trim();
  const markdown = input.markdown.trim();
  if (!title || !markdown) throw new Error("Plan title and Markdown are required.");
  if (title === plan.title && markdown === plan.markdown) return session;
  const updatedAt = new Date().toISOString();
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
