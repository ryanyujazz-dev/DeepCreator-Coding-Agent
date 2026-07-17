import { randomUUID } from "node:crypto";
import { ApprovalDecision, PermissionCapability, PermissionRisk } from "../shared/runtimeTypes";
import { SignalStore } from "./signalStore";

type PendingApproval = {
  cycleKey: string;
  sessionKey: string;
  callKey: string;
  capability: PermissionCapability;
  risk: PermissionRisk;
  target: string;
  toolName: string;
  resolve: (decision: ApprovalDecision) => void;
};

export class LiveRegistry {
  private readonly cycles = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();

  startCycle(cycleKey: string): AbortController {
    const controller = new AbortController();
    this.cycles.set(cycleKey, controller);
    return controller;
  }

  finishCycle(cycleKey: string): void {
    this.cycles.delete(cycleKey);
  }

  cancelCycle(cycleKey: string): boolean {
    const controller = this.cycles.get(cycleKey);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async requestApproval(input: {
    callKey: string;
    capability: PermissionCapability;
    cycleKey: string;
    sessionKey: string;
    store: SignalStore;
    title: string;
    detail: string;
    risk: PermissionRisk;
    target: string;
    toolName: string;
    signal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    const approvalKey = `approval_${randomUUID()}`;
    input.store.append({
      cycleKey: input.cycleKey,
      payload: {
        approvalKey,
        callKey: input.callKey,
        capability: input.capability,
        choices: ["allow_once", "allow_cycle", "allow_session", "deny"],
        detail: input.detail,
        risk: input.risk,
        state: "pending",
        target: input.target,
        title: input.title,
      },
      sessionKey: input.sessionKey,
      topic: "interaction.approval.requested"
    });

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision) => {
        this.approvals.delete(approvalKey);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => {
        if (!this.approvals.has(approvalKey)) return;
        input.store.append({
          cycleKey: input.cycleKey,
          payload: { approvalKey, state: "dismissed" as const },
          sessionKey: input.sessionKey,
          topic: "interaction.approval.resolved"
        });
        settle("deny");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(approvalKey, {
        cycleKey: input.cycleKey,
        callKey: input.callKey,
        capability: input.capability,
        risk: input.risk,
        resolve: settle,
        sessionKey: input.sessionKey,
        target: input.target,
        toolName: input.toolName
      });
    });
  }

  resolveApproval(input: {
    approvalKey: string;
    decision: ApprovalDecision;
    store: SignalStore;
  }): boolean {
    const pending = this.approvals.get(input.approvalKey);
    if (!pending) return false;
    const allowed = input.decision !== "deny";
    if (input.decision === "allow_cycle" || input.decision === "allow_session") {
      const session = input.store.getSession(pending.sessionKey);
      if (session) {
        input.store.append({
          payload: {
            grants: [
              ...session.permissionGrants,
              {
                capability: pending.capability,
                createdAt: new Date().toISOString(),
                cycleKey: input.decision === "allow_cycle" ? pending.cycleKey : undefined,
                grantKey: `grant_${randomUUID()}`,
                scope: input.decision === "allow_cycle" ? "cycle" as const : "session" as const,
                targetPattern: pending.target,
                toolName: pending.toolName
              }
            ]
          },
          sessionKey: pending.sessionKey,
          topic: "session.permissionGrants.replaced"
        });
      }
    }
    input.store.append({
      cycleKey: pending.cycleKey,
      payload: {
        approvalKey: input.approvalKey,
        state: allowed ? ("allowed" as const) : ("denied" as const)
      },
      sessionKey: pending.sessionKey,
      topic: "interaction.approval.resolved"
    });
    pending.resolve(input.decision);
    return true;
  }
}
