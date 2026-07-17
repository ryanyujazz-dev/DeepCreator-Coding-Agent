import {
  ActivityUnitView,
  AgentSignal,
  ApprovalView,
  CyclePhase,
  CycleView,
  emptyWorkspaceDelta,
  PlanStepView,
  PermissionGrantView,
  PermissionProfileKey,
  UsageView,
  WorkspaceDeltaView,
  WorkspaceSessionView,
  SessionRegistration,
  ToolExecutionView
} from "./runtimeTypes";

type OpenCyclePayload = Pick<CycleView, "model" | "prompt" | "startedAt">;
type OpenUnitPayload = Omit<ActivityUnitView, "body" | "cycleKey" | "phase" | "unitKey"> & {
  body?: string;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findCycle(view: WorkspaceSessionView, signal: AgentSignal): CycleView | undefined {
  return view.cycles.find((cycle) => cycle.cycleKey === signal.scope.cycleKey);
}

function findUnit(cycle: CycleView | undefined, signal: AgentSignal): ActivityUnitView | undefined {
  return cycle?.units.find((unit) => unit.unitKey === signal.scope.unitKey);
}

export function reduceSignal(current: WorkspaceSessionView, signal: AgentSignal): WorkspaceSessionView {
  if (signal.scope.sessionKey !== current.sessionKey || signal.offset <= current.lastOffset) return current;

  const next = clone(current);
  next.lastOffset = signal.offset;
  next.updatedAt = signal.emittedAt;

  if (signal.topic === "session.context.replaced") {
    const payload = signal.payload as {
      compactSummary?: string;
      contextTokenEstimate: number;
    };
    next.compactSummary = payload.compactSummary;
    next.contextTokenEstimate = payload.contextTokenEstimate;
    return next;
  }

  if (signal.topic === "session.permissionProfile.changed") {
    next.permissionProfile = (signal.payload as { permissionProfile: PermissionProfileKey }).permissionProfile;
    return next;
  }

  if (signal.topic === "session.permissionGrants.replaced") {
    next.permissionGrants = clone((signal.payload as { grants: PermissionGrantView[] }).grants);
    return next;
  }

  if (signal.topic === "cycle.accepted") {
    const payload = signal.payload as OpenCyclePayload;
    const cycleKey = signal.scope.cycleKey;
    if (!cycleKey || next.cycleKeys.includes(cycleKey)) return next;
    next.cycleKeys.push(cycleKey);
    next.cycles.push({
      approvals: [],
      cycleKey,
      failure: undefined,
      finalResponse: "",
      lastOffset: signal.offset,
      model: payload.model,
      phase: "queued",
      plan: [],
      prompt: payload.prompt,
      sessionKey: next.sessionKey,
      startedAt: payload.startedAt,
      units: [],
      workspaceDelta: emptyWorkspaceDelta()
    });
    return next;
  }

  const cycle = findCycle(next, signal);
  if (!cycle) return next;
  cycle.lastOffset = signal.offset;

  switch (signal.topic) {
    case "cycle.executing":
      cycle.phase = "active";
      break;
    case "cycle.plan.replaced":
      cycle.plan = clone((signal.payload as { steps: PlanStepView[] }).steps);
      break;
    case "cycle.workspaceDelta.replaced":
      cycle.workspaceDelta = clone(signal.payload as WorkspaceDeltaView);
      break;
    case "cycle.usage.replaced":
      cycle.usage = clone(signal.payload as UsageView);
      if (cycle.usage.contextTokens !== undefined) next.contextTokenEstimate = cycle.usage.contextTokens;
      break;
    case "cycle.settled": {
      const payload = signal.payload as {
        phase: Extract<CyclePhase, "succeeded" | "failed" | "cancelled">;
        finalResponse?: string;
        failure?: string;
        recovery?: CycleView["recovery"];
        settledAt: string;
      };
      cycle.phase = payload.phase;
      cycle.finalResponse = payload.finalResponse ?? cycle.finalResponse;
      cycle.failure = payload.failure;
      cycle.recovery = clone(payload.recovery);
      cycle.settledAt = payload.settledAt;
      cycle.units = cycle.units.map((unit) => unit.phase === "open"
        ? { ...unit, error: payload.failure, phase: payload.phase === "cancelled" ? "cancelled" : "failed", sealedAt: payload.settledAt }
        : unit);
      cycle.approvals = cycle.approvals.map((approval) => approval.state === "pending"
        ? { ...approval, state: "dismissed" }
        : approval);
      break;
    }
    case "unit.opened": {
      const payload = signal.payload as OpenUnitPayload;
      if (!signal.scope.unitKey || cycle.units.some((unit) => unit.unitKey === signal.scope.unitKey)) break;
      cycle.units.push({
        ...clone(payload),
        body: payload.body ?? "",
        cycleKey: cycle.cycleKey,
        phase: "open",
        unitKey: signal.scope.unitKey
      });
      break;
    }
    case "unit.thinking.appended":
    case "unit.message.appended":
    case "unit.commandOutput.appended": {
      const unit = findUnit(cycle, signal);
      if (unit) unit.body += (signal.payload as { text: string }).text;
      break;
    }
    case "unit.toolArguments.appended": {
      const unit = findUnit(cycle, signal);
      if (unit?.tool) unit.tool.argumentsPreview += (signal.payload as { text: string }).text;
      break;
    }
    case "unit.tool.updated": {
      const unit = findUnit(cycle, signal);
      const payload = signal.payload as {
        kind?: ActivityUnitView["kind"];
        title?: string;
        tool: Partial<ToolExecutionView>;
      };
      if (unit?.tool) Object.assign(unit.tool, clone(payload.tool));
      if (unit && payload.kind) unit.kind = payload.kind;
      if (unit && payload.title) unit.title = payload.title;
      break;
    }
    case "unit.sealed": {
      const unit = findUnit(cycle, signal);
      if (!unit) break;
      const payload = signal.payload as Partial<ActivityUnitView> & {
        phase: ActivityUnitView["phase"];
        sealedAt: string;
      };
      Object.assign(unit, clone(payload));
      break;
    }
    case "interaction.approval.requested":
      cycle.phase = "awaiting_approval";
      cycle.approvals.push(clone(signal.payload as ApprovalView));
      break;
    case "interaction.approval.resolved": {
      const payload = signal.payload as Pick<ApprovalView, "approvalKey" | "state">;
      const approval = cycle.approvals.find((item) => item.approvalKey === payload.approvalKey);
      if (approval) approval.state = payload.state;
      if (cycle.phase === "awaiting_approval") cycle.phase = "active";
      break;
    }
    default:
      break;
  }

  return next;
}

export function createSessionView(registration: SessionRegistration, offset = 0): WorkspaceSessionView {
  return {
    ...registration,
    compactSummary: undefined,
    contextTokenEstimate: 0,
    cycleKeys: [],
    cycles: [],
    permissionGrants: [],
    permissionProfile: registration.permissionProfile ?? "request_approval",
    lastOffset: offset,
    updatedAt: registration.createdAt
  };
}

export function rebuildSession(signals: AgentSignal[]): WorkspaceSessionView | undefined {
  const ordered = [...signals].sort((left, right) => left.offset - right.offset);
  const registrationSignal = ordered.find((signal) => signal.topic === "session.registered");
  if (!registrationSignal) return undefined;
  const registration = registrationSignal.payload as SessionRegistration;
  const initial = createSessionView(registration);
  return ordered.reduce((view, signal) => {
    if (signal.topic === "session.registered") {
      return { ...view, lastOffset: signal.offset, updatedAt: signal.emittedAt };
    }
    return reduceSignal(view, signal);
  }, initial);
}

export function reduceSignals(view: WorkspaceSessionView, signals: AgentSignal[]): WorkspaceSessionView {
  return signals.reduce(reduceSignal, view);
}
