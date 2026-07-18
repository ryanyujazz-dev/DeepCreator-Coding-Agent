import { randomUUID } from "node:crypto";
import { ApprovalChoice, AccessScope, AccessRisk } from "../../shared/contracts/runtime";
import { RuntimeRepo } from "./runtimeRepo";

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

  startRun(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, controller);
    return controller;
  }

  finishRun(runId: string): void {
    this.runs.delete(runId);
  }

  cancelRun(runId: string): boolean {
    const controller = this.runs.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async requestApproval(input: {
    callId: string;
    capability: AccessScope;
    runId: string;
    sessionId: string;
    store: RuntimeRepo;
    title: string;
    detail: string;
    risk: AccessRisk;
    target: string;
    toolName: string;
    signal?: AbortSignal;
  }): Promise<ApprovalChoice> {
    const approvalId = `approval_${randomUUID()}`;
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
    store: RuntimeRepo;
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
                createdAt: new Date().toISOString(),
                runId: input.decision === "allow_run" ? pending.runId : undefined,
                grantId: `grant_${randomUUID()}`,
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
