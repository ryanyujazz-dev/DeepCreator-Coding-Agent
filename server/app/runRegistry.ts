import { ApprovalChoice, AccessScope, AccessRisk } from "../../shared/contracts/runtime";
import { EventPort, SessionPort } from "./runtimeRepo";
import { SystemPort } from "./systemPort";

type RunRegistryPorts = EventPort & SessionPort;

type PendingApproval = {
  runId: string;
  sessionId: string;
  callId: string;
  capability: AccessScope;
  risk: AccessRisk;
  target: string;
  toolName: string;
  resolve: (decision: ApprovalChoice) => void;
};

type InterruptibleStep = {
  controller: AbortController;
  detach: () => void;
  reason?: "steer";
};

export type RunStepControl = {
  interruptedBySteer: () => boolean;
  release: () => void;
  signal: AbortSignal;
};

export type RunSteer = {
  prompt: string;
  steerId: string;
};

export class RunRegistry {
  private readonly runs = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly finishListeners = new Map<string, Set<() => void>>();
  private readonly interruptibleSteps = new Map<string, InterruptibleStep>();
  private readonly steers = new Map<string, RunSteer[]>();
  private readonly children = new Map<string, Set<string>>();
  private readonly parents = new Map<string, string>();

  constructor(readonly system: SystemPort) {}

  startRun(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, controller);
    return controller;
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  finishRun(runId: string): void {
    const step = this.interruptibleSteps.get(runId);
    step?.detach();
    this.interruptibleSteps.delete(runId);
    this.runs.delete(runId);
    this.steers.delete(runId);
    const parent = this.parents.get(runId);
    if (parent) {
      this.children.get(parent)?.delete(runId);
      this.parents.delete(runId);
    }
    if ((this.children.get(runId)?.size ?? 0) === 0) this.children.delete(runId);
    const listeners = this.finishListeners.get(runId);
    this.finishListeners.delete(runId);
    listeners?.forEach((listener) => listener());
  }

  enqueueSteer(runId: string, steer: RunSteer): boolean {
    if (!this.runs.has(runId)) return false;
    const pending = this.steers.get(runId) ?? [];
    pending.push(steer);
    this.steers.set(runId, pending);
    return true;
  }

  interruptForSteer(runId: string): boolean {
    const step = this.interruptibleSteps.get(runId);
    if (!step) return this.runs.has(runId);
    step.reason = "steer";
    step.controller.abort(new DOMException("当前步骤已被用户引导打断。", "AbortError"));
    return true;
  }

  hasSteers(runId: string): boolean {
    return (this.steers.get(runId)?.length ?? 0) > 0;
  }

  beginInterruptibleStep(runId: string): RunStepControl {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} is not active.`);
    const previous = this.interruptibleSteps.get(runId);
    previous?.detach();
    const controller = new AbortController();
    const step: InterruptibleStep = { controller, detach: () => undefined };
    const abortWithRun = () => controller.abort(run.signal.reason);
    run.signal.addEventListener("abort", abortWithRun, { once: true });
    step.detach = () => run.signal.removeEventListener("abort", abortWithRun);
    this.interruptibleSteps.set(runId, step);
    if (run.signal.aborted) abortWithRun();
    return {
      interruptedBySteer: () => step.reason === "steer",
      release: () => {
        if (this.interruptibleSteps.get(runId) !== step) return;
        step.detach();
        this.interruptibleSteps.delete(runId);
      },
      signal: controller.signal
    };
  }

  takeSteers(runId: string): RunSteer[] {
    const pending = this.steers.get(runId) ?? [];
    this.steers.delete(runId);
    return pending;
  }

  afterRun(runId: string, listener: () => void): () => void {
    if (!this.runs.has(runId)) {
      listener();
      return () => undefined;
    }
    const listeners = this.finishListeners.get(runId) ?? new Set<() => void>();
    listeners.add(listener);
    this.finishListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.finishListeners.delete(runId);
    };
  }

  cancelRun(runId: string): boolean {
    const controller = this.runs.get(runId);
    if (!controller) return false;
    for (const childRunId of this.childRunIds(runId)) this.cancelRun(childRunId);
    controller.abort();
    return true;
  }

  linkChild(parentRunId: string, childRunId: string): void {
    const children = this.children.get(parentRunId) ?? new Set<string>();
    children.add(childRunId);
    this.children.set(parentRunId, children);
    this.parents.set(childRunId, parentRunId);
  }

  childRunIds(parentRunId: string): string[] {
    return [...(this.children.get(parentRunId) ?? [])];
  }

  waitForRun(runId: string, timeoutMs = 15_000): Promise<boolean> {
    if (!this.runs.has(runId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const state: { timer?: ReturnType<typeof setTimeout> } = {};
      let unsubscribe: () => void = () => undefined;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        if (state.timer) clearTimeout(state.timer);
        unsubscribe();
        resolve(completed);
      };
      unsubscribe = this.afterRun(runId, () => finish(true));
      state.timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    });
  }

  async cancelAllAndWait(timeoutMs = 1_500): Promise<void> {
    const runIds = [...this.runs.keys()];
    if (runIds.length === 0) return;
    const settled = Promise.all(runIds.map((runId) => new Promise<void>((resolve) => {
      this.afterRun(runId, resolve);
      this.cancelRun(runId);
    })));
    await Promise.race([
      settled,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  async requestApproval(input: {
    callId: string;
    capability: AccessScope;
    runId: string;
    sessionId: string;
    store: RunRegistryPorts;
    title: string;
    detail: string;
    risk: AccessRisk;
    target: string;
    toolName: string;
    signal?: AbortSignal;
  }): Promise<ApprovalChoice> {
    const approvalId = this.system.createId("approval");
    input.store.append({
      runId: input.runId,
      data: {
        approvalId,
        callId: input.callId,
        capability: input.capability,
        choices: ["allow_once", "allow_run", "allow_session", "deny"],
        detail: input.detail,
        risk: input.risk,
        state: "pending",
        target: input.target,
        title: input.title,
      },
      sessionId: input.sessionId,
      type: "approval.requested"
    });

    return new Promise<ApprovalChoice>((resolve) => {
      const settle = (decision: ApprovalChoice) => {
        this.approvals.delete(approvalId);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => {
        if (!this.approvals.has(approvalId)) return;
        input.store.append({
          runId: input.runId,
          data: { approvalId, state: "dismissed" as const },
          sessionId: input.sessionId,
          type: "approval.resolved"
        });
        settle("deny");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(approvalId, {
        runId: input.runId,
        callId: input.callId,
        capability: input.capability,
        risk: input.risk,
        resolve: settle,
        sessionId: input.sessionId,
        target: input.target,
        toolName: input.toolName
      });
    });
  }

  resolveApproval(input: {
    approvalId: string;
    decision: ApprovalChoice;
    store: RunRegistryPorts;
  }): boolean {
    const pending = this.approvals.get(input.approvalId);
    if (!pending) return false;
    const allowed = input.decision !== "deny";
    if (input.decision === "allow_run" || input.decision === "allow_session") {
      const session = input.store.getSession(pending.sessionId);
      if (session) {
        input.store.append({
          data: {
            grants: [
              ...session.grants,
              {
                capability: pending.capability,
                createdAt: this.system.now(),
                runId: input.decision === "allow_run" ? pending.runId : undefined,
                grantId: this.system.createId("grant"),
                scope: input.decision === "allow_run" ? "run" as const : "session" as const,
                targetPattern: pending.target,
                toolName: pending.toolName
              }
            ]
          },
          sessionId: pending.sessionId,
          type: "session.updated"
        });
      }
    }
    input.store.append({
      runId: pending.runId,
      data: {
        approvalId: input.approvalId,
        state: allowed ? ("allowed" as const) : ("denied" as const)
      },
      sessionId: pending.sessionId,
      type: "approval.resolved"
    });
    pending.resolve(input.decision);
    return true;
  }
}
