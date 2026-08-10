import { AccessMode, FollowUp, Mode, PlanEntry, Session } from "../../shared/contracts/runtime";
import { AppError } from "./appError";
import { RunRegistry } from "./runRegistry";
import { ContextPort, EventPort, SessionPort } from "./runtimeRepo";
import { StartRun } from "./startRun";
import { SystemPort } from "./systemPort";
import { finishRun } from "./runLifecycle";

type FollowUpPorts = ContextPort & EventPort & SessionPort;

export type QueueFollowUpInput = {
  accessMode: AccessMode;
  mode: Mode;
  model: string;
  planEntry: PlanEntry;
  prompt: string;
  requestId?: string;
  sessionId: string;
};

export class FollowUpService {
  private readonly draining = new Set<string>();
  private readonly watchers = new Map<string, () => void>();

  constructor(private readonly deps: {
    registry: RunRegistry;
    startRun: StartRun;
    store: FollowUpPorts;
    system: SystemPort;
  }) {}

  async queue(input: QueueFollowUpInput): Promise<{ session: Session }> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new AppError("prompt is required", "invalid_input");
    const session = this.requireSession(input.sessionId);
    if (input.requestId) {
      const existing = this.deps.store.readEvents(input.sessionId).find((event) =>
        event.type === "follow_up.queued" && event.data.followUp.requestId === input.requestId
      );
      if (existing) return { session };
    }
    const activeRun = this.activeRun(session);
    if (!activeRun) {
      const result = await this.deps.startRun.execute(input);
      return { session: result.session };
    }
    const followUp: FollowUp = {
      accessMode: input.accessMode,
      createdAt: this.deps.system.now(),
      followUpId: this.deps.system.createId("follow_up"),
      mode: input.mode,
      model: input.model,
      planEntry: input.planEntry,
      prompt,
      ...(input.requestId ? { requestId: input.requestId } : {})
    };
    this.deps.store.append({ data: { followUp }, sessionId: input.sessionId, type: "follow_up.queued" });
    this.watch(input.sessionId);
    return { session: this.requireSession(input.sessionId) };
  }

  async interruptQuestion(input: QueueFollowUpInput & {
    interactionId: string;
    requestId: string;
  }): Promise<{ idempotent: boolean; session: Session }> {
    const session = this.requireSession(input.sessionId);
    const existingFollowUp = this.deps.store.readEvents(input.sessionId).find((event) =>
      event.type === "follow_up.queued" && event.data.followUp.requestId === input.requestId
    );
    if (existingFollowUp) return { idempotent: true, session };
    const question = session.questions.find((item) => item.interactionId === input.interactionId);
    if (!question) throw new AppError("question interaction not found", "not_found");
    if (question.status !== "pending") throw new AppError("question interaction is stale", "stale_revision");
    const run = session.runs.find((item) => item.runId === question.runId);
    if (!run || run.status !== "waiting") throw new AppError("question run is not waiting", "not_waiting");

    await this.queue(input);
    const resolvedAt = this.deps.system.now();
    const message = "用户选择结束问题澄清环节";
    this.deps.store.append({
      data: { interactionId: question.interactionId, resolvedAt, status: "cancelled" },
      runId: question.runId,
      sessionId: input.sessionId,
      type: "question.answered"
    });
    this.deps.store.appendContextEntry({
      createdAt: resolvedAt,
      isError: true,
      kind: "tool_result",
      metadata: {
        interactionId: question.interactionId,
        interruptionReason: "user_started_new_run"
      },
      runId: question.runId,
      sessionId: input.sessionId,
      source: "runtime",
      text: JSON.stringify({
        interactionId: question.interactionId,
        message,
        reason: "user_started_new_run",
        status: "interrupted"
      }),
      toolCallKey: question.callId,
      toolName: "ask_user"
    });
    finishRun({
      answer: message,
      projectRoot: session.projectRoot,
      runId: question.runId,
      sessionId: input.sessionId,
      status: "cancelled",
      store: this.deps.store,
      system: this.deps.system
    });
    return { idempotent: false, session: this.requireSession(input.sessionId) };
  }

  remove(sessionId: string, followUpId: string): { session: Session } {
    const session = this.requireSession(sessionId);
    if (session.followUps.some((item) => item.followUpId === followUpId)) {
      this.deps.store.append({ data: { followUpId }, sessionId, type: "follow_up.removed" });
    }
    return { session: this.requireSession(sessionId) };
  }

  steer(sessionId: string, followUpId: string): { session: Session } {
    const session = this.requireSession(sessionId);
    const followUp = session.followUps.find((item) => item.followUpId === followUpId);
    if (!followUp) throw new AppError("queued follow-up not found", "not_found");
    const activeRun = this.activeRun(session);
    if (!activeRun || !["running", "waiting"].includes(activeRun.status) || !this.deps.registry.enqueueSteer(activeRun.runId, {
      prompt: followUp.prompt,
      steerId: followUp.followUpId
    })) {
      throw new AppError("the active run cannot be steered now", "conflict");
    }
    const at = this.deps.system.now();
    const activityId = this.deps.system.createId("activity");
    this.deps.store.appendContextEntry({
      createdAt: at,
      kind: "human_text",
      metadata: { steerId: followUp.followUpId },
      runId: activeRun.runId,
      sessionId,
      source: "user",
      text: followUp.prompt
    });
    this.deps.store.appendMany([{
      data: { followUpId },
      sessionId,
      type: "follow_up.removed"
    }, {
      activityId,
      data: {
        audience: "user",
        body: followUp.prompt,
        kind: "user_message",
        startedAt: at
      },
      runId: activeRun.runId,
      sessionId,
      type: "activity.started"
    }, {
      activityId,
      data: { finishedAt: at, status: "completed" },
      runId: activeRun.runId,
      sessionId,
      type: "activity.finished"
    }]);
    this.deps.registry.interruptForSteer(activeRun.runId);
    return { session: this.requireSession(sessionId) };
  }

  recover(): void {
    for (const summary of this.deps.store.listSessions()) {
      const session = this.deps.store.getSession(summary.sessionId);
      if (!session?.followUps.length) continue;
      this.watch(session.sessionId);
      void this.drain(session.sessionId).catch(() => undefined);
    }
  }

  close(): void {
    for (const unsubscribe of this.watchers.values()) unsubscribe();
    this.watchers.clear();
  }

  private activeRun(session: Session) {
    return [...session.runs].reverse().find((run) => ["queued", "running", "waiting"].includes(run.status));
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      const session = this.requireSession(sessionId);
      if (this.activeRun(session)) return;
      const followUp = session.followUps[0];
      if (!followUp) {
        this.unwatch(sessionId);
        return;
      }
      await this.deps.startRun.execute({
        ...followUp,
        consumeFollowUpId: followUp.followUpId,
        sessionId
      });
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private requireSession(sessionId: string): Session {
    const session = this.deps.store.getSession(sessionId);
    if (!session) throw new AppError("session not found", "not_found");
    return session;
  }

  private unwatch(sessionId: string): void {
    this.watchers.get(sessionId)?.();
    this.watchers.delete(sessionId);
  }

  private watch(sessionId: string): void {
    if (this.watchers.has(sessionId)) return;
    this.watchers.set(sessionId, this.deps.store.subscribe(sessionId, (events) => {
      if (events.some((event) => event.type === "run.finished")) void this.drain(sessionId).catch(() => undefined);
      if (events.some((event) => event.type === "follow_up.removed") && !this.deps.store.getSession(sessionId)?.followUps.length) {
        this.unwatch(sessionId);
      }
    }));
  }
}
