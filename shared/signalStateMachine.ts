import { AgentSignal, isTerminalCycle, SignalTopic, WorkspaceSessionView } from "./runtimeTypes";

export type SignalDraft = Pick<AgentSignal, "payload" | "scope" | "topic">;

const UNIT_DELTA_TOPICS = new Set<SignalTopic>([
  "unit.thinking.appended",
  "unit.message.appended",
  "unit.toolArguments.appended",
  "unit.tool.updated",
  "unit.commandOutput.appended"
]);

export function assertSignalTransition(view: WorkspaceSessionView, draft: SignalDraft): void {
  if (draft.scope.sessionKey !== view.sessionKey) {
    throw new Error("Signal session scope does not match the target session.");
  }
  if (draft.topic === "session.registered") {
    throw new Error("A session can only be registered once.");
  }
  if (
    draft.topic === "session.context.replaced" ||
    draft.topic === "session.permissionProfile.changed" ||
    draft.topic === "session.permissionGrants.replaced"
  ) return;

  const cycle = view.cycles.find((item) => item.cycleKey === draft.scope.cycleKey);
  if (draft.topic === "cycle.accepted") {
    if (!draft.scope.cycleKey) throw new Error("cycle.accepted requires cycleKey.");
    if (cycle) throw new Error("WorkCycle already exists.");
    return;
  }
  if (!cycle) throw new Error(`${draft.topic} requires an existing WorkCycle.`);

  if (draft.topic === "cycle.executing") {
    if (cycle.phase !== "queued") throw new Error("Only a queued WorkCycle can start executing.");
    return;
  }
  if (draft.topic === "cycle.settled") {
    if (isTerminalCycle(cycle.phase)) throw new Error("WorkCycle is already settled.");
    return;
  }
  if (isTerminalCycle(cycle.phase)) {
    throw new Error(`Cannot append ${draft.topic} after WorkCycle settlement.`);
  }

  if (draft.topic === "unit.opened") {
    if (cycle.phase !== "active" && cycle.phase !== "awaiting_approval") {
      throw new Error("ActivityUnit can only open while a WorkCycle is active.");
    }
    if (!draft.scope.unitKey) throw new Error("unit.opened requires unitKey.");
    if (cycle.units.some((unit) => unit.unitKey === draft.scope.unitKey)) {
      throw new Error("ActivityUnit already exists.");
    }
    return;
  }

  if (UNIT_DELTA_TOPICS.has(draft.topic) || draft.topic === "unit.sealed") {
    const unit = cycle.units.find((item) => item.unitKey === draft.scope.unitKey);
    if (!unit) throw new Error(`${draft.topic} requires an existing ActivityUnit.`);
    if (unit.phase !== "open") throw new Error(`Cannot append ${draft.topic} to a sealed ActivityUnit.`);
  }
}
