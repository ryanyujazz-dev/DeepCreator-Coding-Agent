import {
  Activity,
  AccessMode,
  Approval,
  Changes,
  Event,
  Grant,
  PlanItem,
  Run,
  RunStatus,
  Session,
  SessionInput,
  ToolState,
  Usage,
  emptyChanges
} from "../contracts/runtime";

type StartRunData = Pick<Run, "model" | "prompt" | "startedAt">;
type StartActivityData = Omit<Activity, "activityId" | "body" | "runId" | "status"> & { body?: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findRun(session: Session, event: Event): Run | undefined {
  return session.runs.find((run) => run.runId === event.scope.runId);
}

function findActivity(run: Run | undefined, event: Event): Activity | undefined {
  return run?.activities.find((activity) => activity.activityId === event.scope.activityId);
}

export function reduceEvent(current: Session, event: Event): Session {
  if (event.scope.sessionId !== current.sessionId || event.offset <= current.lastOffset) return current;

  const next = clone(current);
  next.lastOffset = event.offset;
  next.updatedAt = event.at;

  if (event.type === "session.updated") {
    const data = event.data as {
      accessMode?: AccessMode;
      compactSummary?: string;
      contextTokens?: number;
      grants?: Grant[];
    };
    if (data.accessMode !== undefined) next.accessMode = data.accessMode;
    if (data.compactSummary !== undefined) next.compactSummary = data.compactSummary;
    if (data.contextTokens !== undefined) next.contextTokens = data.contextTokens;
    if (data.grants !== undefined) next.grants = clone(data.grants);
    return next;
  }

  if (event.type === "run.started") {
    const data = event.data as StartRunData;
    const runId = event.scope.runId;
    if (!runId || next.runIds.includes(runId)) return next;
    next.runIds.push(runId);
    next.runs.push({
      activities: [],
      answer: "",
      approvals: [],
      changes: emptyChanges(),
      lastOffset: event.offset,
      model: data.model,
      plan: [],
      prompt: data.prompt,
      runId,
      sessionId: next.sessionId,
      startedAt: data.startedAt,
      status: "running"
    });
    return next;
  }

  const run = findRun(next, event);
  if (!run) return next;
  run.lastOffset = event.offset;

  switch (event.type) {
    case "plan.changed":
      run.plan = clone((event.data as { items: PlanItem[] }).items);
      break;
    case "changes.changed":
      run.changes = clone(event.data as Changes);
      break;
    case "usage.changed":
      run.usage = clone(event.data as Usage);
      if (run.usage.contextTokens !== undefined) next.contextTokens = run.usage.contextTokens;
      break;
    case "activity.started": {
      const data = event.data as StartActivityData;
      if (!event.scope.activityId || run.activities.some((activity) => activity.activityId === event.scope.activityId)) break;
      run.activities.push({
        ...clone(data),
        activityId: event.scope.activityId,
        body: data.body ?? "",
        runId: run.runId,
        status: "running"
      });
      break;
    }
    case "activity.updated": {
      const activity = findActivity(run, event);
      if (!activity) break;
      const data = event.data as {
        argumentsDelta?: string;
        bodyDelta?: string;
        kind?: Activity["kind"];
        title?: string;
        tool?: Partial<ToolState>;
      };
      if (data.bodyDelta) activity.body += data.bodyDelta;
      if (data.argumentsDelta && activity.tool) activity.tool.argumentsPreview += data.argumentsDelta;
      if (data.tool && activity.tool) Object.assign(activity.tool, clone(data.tool));
      if (data.kind) activity.kind = data.kind;
      if (data.title) activity.title = data.title;
      break;
    }
    case "activity.finished": {
      const activity = findActivity(run, event);
      if (!activity) break;
      const data = event.data as Partial<Activity> & {
        finishedAt: string;
        status: Activity["status"];
      };
      Object.assign(activity, clone(data));
      break;
    }
    case "approval.requested":
      run.status = "waiting";
      run.approvals.push(clone(event.data as Approval));
      break;
    case "approval.resolved": {
      const data = event.data as Pick<Approval, "approvalId" | "state">;
      const approval = run.approvals.find((item) => item.approvalId === data.approvalId);
      if (approval) approval.state = data.state;
      if (run.status === "waiting") run.status = "running";
      break;
    }
    case "run.finished": {
      const data = event.data as {
        answer?: string;
        error?: string;
        finishedAt: string;
        resume?: Run["resume"];
        status: Extract<RunStatus, "completed" | "failed" | "cancelled">;
      };
      run.answer = data.answer ?? run.answer;
      run.error = data.error;
      run.finishedAt = data.finishedAt;
      run.resume = clone(data.resume);
      run.status = data.status;
      run.activities = run.activities.map((activity) => activity.status === "running"
        ? {
            ...activity,
            error: data.error,
            finishedAt: data.finishedAt,
            status: data.status === "cancelled" ? "cancelled" : "failed"
          }
        : activity);
      run.approvals = run.approvals.map((approval) => approval.state === "pending"
        ? { ...approval, state: "dismissed" }
        : approval);
      break;
    }
    default:
      break;
  }

  return next;
}

export function createSession(input: SessionInput, offset = 0): Session {
  return {
    ...input,
    accessMode: input.accessMode ?? "request_approval",
    compactSummary: undefined,
    contextTokens: 0,
    grants: [],
    lastOffset: offset,
    runIds: [],
    runs: [],
    updatedAt: input.createdAt
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
