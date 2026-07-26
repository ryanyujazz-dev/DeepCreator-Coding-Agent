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

export class RunRegistry {
  private readonly runs = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly finishListeners = new Map<string, Set<() => void>>();

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
    this.runs.delete(runId);
    const listeners = this.finishListeners.get(runId);
    this.finishListeners.delete(runId);
    listeners?.forEach((listener) => listener());
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
    controller.abort();
    return true;
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
