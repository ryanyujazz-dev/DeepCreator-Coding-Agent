import {
  Activity,
  Event,
  Run,
  Session,
  SessionInput,
  ToolState,
  emptyChanges
} from "../contracts/runtime";

// Event payloads are external inputs (SSE / REST snapshots) that may be frozen or reused
// across calls, so they are deep-copied on import via structuredClone. The Session graph
// itself is NEVER cloned wholesale: reduceEvent builds the next Session by structural sharing
// (shallow-copy the spine, copy-on-write only the arrays/objects along the mutated path) so
// unchanged subtrees — especially already-completed Runs — keep their references across events
// and downstream React.memo / RunTimeline can skip them. Per-event cost drops from O(session
// size) (whole-graph structuredClone) to O(touched path).
function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Event type: ${JSON.stringify(value)}`);
}

// Copy-on-write: return a new array equal to `arr` but with `arr[index]` replaced by `next`.
// The original array and its other elements are not copied or mutated.
function withUpdatedElement<T>(arr: T[], index: number, next: T): T[] {
  const copy = arr.slice();
  copy[index] = next;
  return copy;
}

export function reduceEvent(current: Session, event: Event): Session {
  if (event.scope.sessionId !== current.sessionId || event.offset <= current.lastOffset) return current;

  // 结构性共享:浅拷贝 session 脊柱。lastOffset/updatedAt 每个通过 offset 校验的事件都会变,
  // 故 session 引用每次必换;未触及的子树(runs/plans/questions/…)保持 current 的原引用。
  const next: Session = { ...current };
  next.lastOffset = event.offset;
  next.updatedAt = event.at;

  // Session creation is reduced by createSession/rebuildSession. Keeping this
  // branch explicit makes the Event union exhaustive without hiding new types.
  if (event.type === "session.created") return next;

  if (event.type === "session.updated") {
    const data = event.data;
    if (data.accessMode !== undefined) next.accessMode = data.accessMode;
    if (data.compactSummary !== undefined) next.compactSummary = data.compactSummary;
    if (data.contextTokens !== undefined) next.contextTokens = data.contextTokens;
    if (data.grants !== undefined) next.grants = clone(data.grants);
    if (data.planEntry !== undefined) next.planEntry = data.planEntry;
    return next;
  }

  if (event.type === "mode.changed") {
    next.mode = event.data.mode;
    if (event.scope.runId) {
      const runIndex = current.runs.findIndex((run) => run.runId === event.scope.runId);
      if (runIndex >= 0) {
        next.runs = withUpdatedElement(current.runs, runIndex, { ...current.runs[runIndex], mode: next.mode });
      }
    }
    return next;
  }

  if (event.type === "follow_up.queued") {
    if (!current.followUps.some((item) => item.followUpId === event.data.followUp.followUpId)) {
      next.followUps = [...current.followUps, clone(event.data.followUp)];
    }
    return next;
  }

  if (event.type === "follow_up.removed") {
    next.followUps = current.followUps.filter((item) => item.followUpId !== event.data.followUpId);
    return next;
  }

  if (event.type === "delegation.created") {
    const delegations = next.delegations ?? [];
    if (!delegations.some((item) => item.delegationId === event.data.delegation.delegationId)) {
      next.delegations = [...delegations, clone(event.data.delegation)];
    }
    const delegation = event.data.delegation;
    applyDelegationToActivity(next, delegation.parentRunId, delegation.parentActivityId, (activity) => ({
      ...activity,
      delegation: {
        agentId: delegation.agentId,
        childRunId: delegation.childRunId,
        childSessionId: delegation.childSessionId,
        createdAt: delegation.createdAt,
        delegationId: delegation.delegationId,
        message: delegation.message,
        status: delegation.status,
        updatedAt: delegation.updatedAt
      }
    }));
    return next;
  }

  if (event.type === "delegation.updated") {
    const delegationIndex = next.delegations?.findIndex((item) => item.delegationId === event.data.delegationId) ?? -1;
    if (delegationIndex < 0) return next;
    const merged = { ...next.delegations![delegationIndex], ...clone(event.data) };
    next.delegations = withUpdatedElement(next.delegations!, delegationIndex, merged);
    applyDelegationToActivity(next, merged.parentRunId, merged.parentActivityId, (activity) => ({
      ...activity,
      delegation: {
        agentId: merged.agentId,
        childRunId: merged.childRunId,
        childSessionId: merged.childSessionId,
        content: merged.content,
        createdAt: merged.createdAt,
        delegationId: merged.delegationId,
        error: merged.error,
        message: merged.message,
        status: merged.status,
        updatedAt: merged.updatedAt
      }
    }));
    return next;
  }

  if (event.type === "delegation.delivered") {
    const delegationIndex = next.delegations?.findIndex((item) => item.delegationId === event.data.delegationId) ?? -1;
    if (delegationIndex >= 0) {
      next.delegations = withUpdatedElement(next.delegations!, delegationIndex, {
        ...next.delegations![delegationIndex],
        deliveryStatus: "delivered",
        updatedAt: event.data.deliveredAt
      });
    }
    return next;
  }

  if (event.type === "run.started") {
    const data = event.data;
    const runId = event.scope.runId;
    if (!runId || current.runIds.includes(runId)) return next;
    next.runIds = [...current.runIds, runId];
    next.runs = [...current.runs, {
      activities: [],
      answer: "",
      approvals: [],
      changes: emptyChanges(),
      lastOffset: event.offset,
      model: data.model,
      protocol: data.protocol,
      mode: data.mode ?? next.mode,
      tasks: [],
      prompt: data.prompt,
      runId,
      sessionId: next.sessionId,
      startedAt: data.startedAt,
      status: "running"
    }];
    return next;
  }

  // Copy-on-write the target Run: new runs array + a shallow-copied Run whose lastOffset is
  // advanced. Every switch case below may mutate `run` (a private copy) and reassign its array
  // fields (activities/approvals/reasoningSteps/outputItems) to fresh arrays — never mutating the
  // shared originals from `current`. Unchanged Runs elsewhere keep their references.
  const runIndex = event.scope.runId ? current.runs.findIndex((item) => item.runId === event.scope.runId) : -1;
  if (runIndex < 0) return next;
  const run: Run = { ...current.runs[runIndex], lastOffset: event.offset };
  next.runs = withUpdatedElement(current.runs, runIndex, run);

  switch (event.type) {
    case "model.output_item.changed": {
      const items = run.outputItems ?? [];
      const item = clone(event.data.item);
      const existing = items.findIndex((candidate) => candidate.itemId === item.itemId && candidate.modelStepId === item.modelStepId);
      run.outputItems = existing < 0 ? [...items, item] : withUpdatedElement(items, existing, item);
      break;
    }
    case "reasoning.updated": {
      if (!event.data.modelStepId) {
        run.reasoning = (run.reasoning ?? "") + event.data.textDelta;
        break;
      }
      const modelStepId = event.data.modelStepId;
      const steps = run.reasoningSteps ?? [];
      const existingIndex = steps.findIndex((step) => step.modelStepId === modelStepId);
      if (existingIndex >= 0) {
        run.reasoningSteps = withUpdatedElement(steps, existingIndex, {
          ...steps[existingIndex],
          text: steps[existingIndex].text + event.data.textDelta
        });
        run.reasoning = (run.reasoning ?? "") + event.data.textDelta;
      } else {
        const separator = run.reasoning
          ? run.reasoning.endsWith("\n") ? "\n" : "\n\n"
          : "";
        run.reasoningSteps = [...steps, { modelStepId, text: event.data.textDelta }];
        run.reasoning = (run.reasoning ?? "") + separator + event.data.textDelta;
      }
      break;
    }
    case "reasoning.title.updated":
      run.reasoningTitle = event.data.title;
      break;
    case "tasks.changed":
      run.tasks = clone(event.data.items);
      break;
    case "plan.proposed":
    case "plan.revised": {
      const plan = clone(event.data.plan);
      // .map returns a fresh array (owned only by `next`), so the subsequent push/index-assign
      // on it does not touch `current.plans`. Superseded Plan gets a new object; others keep refs.
      const superseded = next.plans.map((item) => item.planId === plan.planId && item.status === "proposed"
        ? { ...item, status: "superseded" as const }
        : item);
      const existing = superseded.findIndex((item) => item.planId === plan.planId && item.revision === plan.revision);
      next.plans = existing === -1 ? [...superseded, plan] : withUpdatedElement(superseded, existing, plan);
      next.mode = "plan";
      run.mode = "plan";
      run.planId = plan.planId;
      run.status = "waiting";
      break;
    }
    case "plan.approved": {
      const data = event.data;
      const planIndex = next.plans.findIndex((item) => item.planId === data.planId && item.revision === data.revision);
      if (planIndex >= 0) {
        next.plans = withUpdatedElement(next.plans, planIndex, {
          ...next.plans[planIndex],
          approvedAt: data.approvedAt,
          status: "approved",
          updatedAt: data.approvedAt
        });
      }
      run.mode = "work";
      run.status = "running";
      break;
    }
    case "plan.rejected": {
      const data = event.data;
      const planIndex = next.plans.findIndex((item) => item.planId === data.planId && item.revision === data.revision);
      if (planIndex >= 0) {
        next.plans = withUpdatedElement(next.plans, planIndex, {
          ...next.plans[planIndex],
          status: "rejected",
          updatedAt: data.resolvedAt
        });
      }
      run.status = data.decision === "continue_planning" ? "running" : "waiting";
      break;
    }
    case "question.asked":
      next.questions = [...next.questions, clone(event.data.question)];
      run.status = "waiting";
      break;
    case "question.answered": {
      const data = event.data;
      const questionIndex = next.questions.findIndex((item) => item.interactionId === data.interactionId);
      if (questionIndex >= 0) {
        next.questions = withUpdatedElement(next.questions, questionIndex, { ...next.questions[questionIndex], ...clone(data) });
      }
      if (data.status === "answered") run.status = "running";
      break;
    }
    case "changes.changed":
      run.changes = clone(event.data);
      break;
    case "usage.changed":
      run.usage = clone(event.data);
      if (run.usage.contextTokens !== undefined) next.contextTokens = run.usage.contextTokens;
      break;
    case "activity.started": {
      const data = event.data;
      if (!event.scope.activityId || run.activities.some((activity) => activity.activityId === event.scope.activityId)) break;
      run.activities = [...run.activities, {
        ...clone(data),
        activityId: event.scope.activityId,
        body: data.body ?? "",
        phase: data.phase ?? "generating_args",
        runId: run.runId,
        status: "running"
      }];
      break;
    }
    case "activity.updated": {
      if (!event.scope.activityId) break;
      const activityIndex = run.activities.findIndex((activity) => activity.activityId === event.scope.activityId);
      if (activityIndex < 0) break;
      const activity = run.activities[activityIndex];
      const data = event.data;
      const updated: Activity = { ...activity };
      if (data.bodyDelta) updated.body = activity.body + data.bodyDelta;
      if (data.command) updated.command = { ...(activity.command ?? { command: data.command.command ?? "" }), ...clone(data.command) };
      // tool: argumentsPreview mutate + partial tool merge must compose onto ONE new tool object
      // (the shared activity.tool must not be mutated in place). Order matches legacy: delta first.
      if (activity.tool) {
        const toolChanges: Partial<ToolState> = {};
        if (data.argumentsDelta) toolChanges.argumentsPreview = activity.tool.argumentsPreview + data.argumentsDelta;
        if (data.tool) Object.assign(toolChanges, clone(data.tool));
        if (Object.keys(toolChanges).length > 0) updated.tool = { ...activity.tool, ...toolChanges };
      }
      if (data.files) updated.files = clone(data.files);
      if (data.citations) updated.citations = clone(data.citations);
      if (data.draft) updated.draft = clone(data.draft);
      if (data.liveFiles) updated.liveFiles = clone(data.liveFiles);
      if (data.status) updated.status = data.status;
      if (data.kind) updated.kind = data.kind;
      if (data.phase !== undefined) updated.phase = data.phase;
      if (data.title) updated.title = data.title;
      run.activities = withUpdatedElement(run.activities, activityIndex, updated);
      break;
    }
    case "activity.finished": {
      if (!event.scope.activityId) break;
      const activityIndex = run.activities.findIndex((activity) => activity.activityId === event.scope.activityId);
      if (activityIndex < 0) break;
      run.activities = withUpdatedElement(run.activities, activityIndex, { ...run.activities[activityIndex], ...clone(event.data) });
      break;
    }
    case "approval.requested":
      run.status = "waiting";
      run.approvals = [...run.approvals, clone(event.data)];
      break;
    case "approval.resolved": {
      const data = event.data;
      const approvalIndex = run.approvals.findIndex((item) => item.approvalId === data.approvalId);
      if (approvalIndex >= 0) {
        run.approvals = withUpdatedElement(run.approvals, approvalIndex, { ...run.approvals[approvalIndex], state: data.state });
      }
      if (run.status === "waiting") run.status = "running";
      break;
    }
    case "run.finished": {
      const data = event.data;
      run.answer = data.answer ?? run.answer;
      run.error = data.error;
      run.finishedAt = data.finishedAt;
      run.resume = clone(data.resume);
      run.status = data.status;
      run.activities = run.activities.map((activity) => {
        if (activity.status === "running") {
          return {
            ...activity,
            error: data.error,
            finishedAt: data.finishedAt,
            status: data.status === "cancelled" ? "cancelled" : "failed"
          };
        }
        // 挂起的思考(thinking suspended)在 run 结束时归到 completed:
        // run 都结束了,思考不可能再恢复。
        if (activity.status === "suspended") {
          return { ...activity, finishedAt: data.finishedAt, status: "completed" };
        }
        return activity;
      });
      run.approvals = run.approvals.map((approval) => approval.state === "pending"
        ? { ...approval, state: "dismissed" }
        : approval);
      break;
    }
    default:
      assertNever(event);
  }

  return next;
}

// Structural-sharing update of one parent Run's one parent Activity for delegation events.
// Reads from `next.runs` (which, at the delegation branch, still aliases current.runs) and
// reassigns next.runs to a fresh runs array with a fresh Run + fresh activities array + the
// activity returned by `build`. `build` receives the existing Activity and must return a full
// Activity (typically `{ ...activity, delegation: {...} }`) — it must NOT return the delegation
// sub-object alone, or the Activity's identity fields (activityId/kind/body) are lost.
// No-op (leaves next.runs untouched) if the run or activity is absent.
function applyDelegationToActivity(
  next: Session,
  parentRunId: string,
  parentActivityId: string,
  build: (activity: Activity) => Activity
): void {
  const runs = next.runs;
  const runIndex = runs.findIndex((item) => item.runId === parentRunId);
  if (runIndex < 0) return;
  const run = runs[runIndex];
  const activityIndex = run.activities.findIndex((item) => item.activityId === parentActivityId);
  if (activityIndex < 0) return;
  const activities = withUpdatedElement(run.activities, activityIndex, build(run.activities[activityIndex]));
  next.runs = withUpdatedElement(runs, runIndex, { ...run, activities });
}

export function createSession(input: SessionInput, offset = 0): Session {
  return {
    ...input,
    accessMode: input.accessMode ?? "request_approval",
    compactSummary: undefined,
    contextTokens: 0,
    grants: [],
    followUps: [],
    delegations: [],
    kind: input.kind ?? "primary",
    mode: input.mode ?? "work",
    planEntry: input.planEntry ?? "suggest",
    plans: [],
    questions: [],
    lastOffset: offset,
    runIds: [],
    runs: [],
    updatedAt: input.createdAt,
    workspaceKind: input.workspaceKind ?? "project"
  };
}

export function rebuildSession(events: Event[]): Session | undefined {
  const ordered = [...events].sort((left, right) => left.offset - right.offset);
  const created = ordered.find((event) => event.type === "session.created");
  if (!created) return undefined;
  const initial = createSession(created.data as SessionInput);
  return ordered.reduce((session, event) => {
    if (event.type === "session.created") {
      return { ...session, lastOffset: event.offset, updatedAt: event.at };
    }
    return reduceEvent(session, event);
  }, initial);
}

export function reduceEvents(session: Session, events: Event[]): Session {
  return events.reduce(reduceEvent, session);
}
