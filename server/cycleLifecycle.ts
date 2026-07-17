import { CycleView, RecoveryCapsule } from "../shared/runtimeTypes";
import type { SignalStore } from "./signalStore";

function recoveryFor(input: {
  cycle: CycleView;
  failureMessage: string;
  failureType: RecoveryCapsule["failureType"];
  projectRoot: string;
  settledAt: string;
}): RecoveryCapsule {
  const completedOperations = input.cycle.units
    .filter((unit) => unit.phase === "succeeded" && unit.kind !== "thinking")
    .map((unit) => unit.tool?.resultSummary || unit.body || unit.title)
    .filter(Boolean)
    .slice(-24);
  const interruptedOperations = input.cycle.units
    .filter((unit) => unit.phase === "open")
    .map((unit) => unit.tool?.displayTarget || unit.title)
    .filter(Boolean);
  const lastProgress = [...input.cycle.units]
    .reverse()
    .find((unit) => unit.kind === "message" && unit.body.trim())
    ?.body.trim();
  return {
    capturedAt: input.settledAt,
    changedFiles: input.cycle.workspaceDelta.files.map((file) => file.path),
    completedOperations,
    failureMessage: input.failureMessage,
    failureType: input.failureType,
    interruptedOperations,
    lastProgress,
    plan: input.cycle.plan,
    projectRoot: input.projectRoot
  };
}

export function settleWorkCycle(input: {
  cycleKey: string;
  failure?: string;
  failureType?: RecoveryCapsule["failureType"];
  finalResponse: string;
  phase: "succeeded" | "failed" | "cancelled";
  projectRoot: string;
  sessionKey: string;
  store: SignalStore;
}): void {
  const settledAt = new Date().toISOString();
  let cycle = input.store.getCycle(input.cycleKey);
  if (!cycle || ["succeeded", "failed", "cancelled"].includes(cycle.phase)) return;

  for (const unit of cycle.units.filter((item) => item.phase === "open")) {
    input.store.append({
      cycleKey: input.cycleKey,
      payload: {
        body: input.failure || unit.body,
        error: input.failure,
        phase: input.phase === "cancelled" ? "cancelled" as const : input.phase === "failed" ? "failed" as const : "succeeded" as const,
        sealedAt: settledAt
      },
      sessionKey: input.sessionKey,
      topic: "unit.sealed",
      unitKey: unit.unitKey
    });
  }

  cycle = input.store.getCycle(input.cycleKey)!;
  for (const approval of cycle.approvals.filter((item) => item.state === "pending")) {
    input.store.append({
      cycleKey: input.cycleKey,
      payload: { approvalKey: approval.approvalKey, state: "dismissed" as const },
      sessionKey: input.sessionKey,
      topic: "interaction.approval.resolved"
    });
  }

  cycle = input.store.getCycle(input.cycleKey)!;
  const recovery = input.phase === "succeeded" || !input.failure
    ? undefined
    : recoveryFor({
        cycle,
        failureMessage: input.failure,
        failureType: input.failureType ?? (input.phase === "cancelled" ? "cancelled" : "runtime_error"),
        projectRoot: input.projectRoot,
        settledAt
      });
  input.store.append({
    cycleKey: input.cycleKey,
    payload: {
      failure: input.failure,
      finalResponse: input.finalResponse,
      phase: input.phase,
      recovery,
      settledAt
    },
    sessionKey: input.sessionKey,
    topic: "cycle.settled"
  });
}
