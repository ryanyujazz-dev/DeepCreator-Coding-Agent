import { EVENT_VERSION, Event, EventType, Session, Task } from "../contracts/runtime";
import { LEGACY_EVENT_VERSION, LegacyEvent } from "./v1";

const TYPE_MAP: Record<string, EventType | undefined> = {
  "session.registered": "session.created",
  "session.context.replaced": "session.updated",
  "session.permissionProfile.changed": "session.updated",
  "session.permissionGrants.replaced": "session.updated",
  "cycle.accepted": "run.started",
  "cycle.plan.replaced": "tasks.changed",
  "cycle.workspaceDelta.replaced": "changes.changed",
  "cycle.usage.replaced": "usage.changed",
  "cycle.settled": "run.finished",
  "unit.opened": "activity.started",
  "unit.thinking.appended": "activity.updated",
  "unit.message.appended": "activity.updated",
  "unit.toolArguments.appended": "activity.updated",
  "unit.tool.updated": "activity.updated",
  "unit.commandOutput.appended": "activity.updated",
  "unit.sealed": "activity.finished",
  "interaction.approval.requested": "approval.requested",
  "interaction.approval.resolved": "approval.resolved"
};

function mapStatus(value: unknown): unknown {
  if (value === "active" || value === "open") return "running";
  if (value === "in_progress") return "running";
  if (value === "awaiting_approval") return "waiting";
  if (value === "succeeded") return "completed";
  return value;
}

function mapChoice(value: unknown): unknown {
  return value === "allow_cycle" ? "allow_run" : value;
}

function mapTool(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return {
    ...source,
    callId: source.callId ?? source.callKey,
    modelStepId: source.modelStepId ?? source.modelStepKey
  };
}

function mapGrant(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return {
    ...source,
    grantId: source.grantId ?? source.grantKey,
    runId: source.runId ?? source.cycleKey,
    scope: source.scope === "cycle" ? "run" : source.scope
  };
}

function mapTasks(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as { items?: Array<Record<string, unknown>>; steps?: Array<Record<string, unknown>> };
  const items = source.items ?? source.steps;
  if (!items) return value;
  return {
    items: items.map((item): Task => ({
      label: String(item.label ?? ""),
      status: mapStatus(item.status ?? item.state) as Task["status"],
      taskId: String(item.taskId ?? item.stepKey ?? item.stepId ?? "")
    }))
  };
}

function mapData(event: LegacyEvent, type: EventType): unknown {
  const data = event.payload && typeof event.payload === "object"
    ? { ...(event.payload as Record<string, unknown>) }
    : event.payload;
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;

  if (type === "session.created") {
    return {
      accessMode: record.permissionProfile ?? "request_approval",
      compactThresholdTokens: Number(record.compactThresholdTokens ?? 850_000),
      contextWindowTokens: Number(record.contextWindowTokens ?? 1_000_000),
      createdAt: String(record.createdAt ?? event.emittedAt),
      model: String(record.model ?? "deepseek-v4-flash"),
      projectRoot: String(record.projectRoot ?? ""),
      workspaceKind: "project",
      sessionId: String(record.sessionId ?? record.sessionKey ?? event.scope.sessionKey),
      title: String(record.title ?? "历史会话")
    };
  }

  if (type === "session.updated") {
    return {
      accessMode: record.permissionProfile,
      compactSummary: record.compactSummary,
      contextTokens: record.contextTokenEstimate,
      grants: Array.isArray(record.grants) ? record.grants.map(mapGrant) : undefined
    };
  }
  if (type === "tasks.changed") return mapTasks(record);
  if (type === "activity.updated") {
    if (typeof record.text === "string") {
      return event.topic === "unit.toolArguments.appended"
        ? { argumentsDelta: record.text }
        : { bodyDelta: record.text };
    }
    return { ...record, tool: mapTool(record.tool) };
  }
  if (type === "activity.started") {
    const { openedAt, ...rest } = record;
    return { ...rest, startedAt: openedAt, tool: mapTool(rest.tool) };
  }
  if (type === "activity.finished") {
    const { phase, sealedAt, ...rest } = record;
    return { ...rest, finishedAt: sealedAt, status: mapStatus(phase), tool: mapTool(rest.tool) };
  }
  if (type === "run.finished") {
    const { failure, finalResponse, phase, recovery, settledAt, ...rest } = record;
    return {
      ...rest,
      answer: finalResponse,
      error: failure,
      finishedAt: settledAt,
      resume: recovery,
      status: mapStatus(phase)
    };
  }
  if (type === "changes.changed" && record.comparisonBase === "cycle_start") {
    record.comparisonBase = "run_start";
  }
  if (type === "approval.requested") {
    return {
      ...record,
      approvalId: record.approvalId ?? record.approvalKey,
      callId: record.callId ?? record.callKey,
      choices: Array.isArray(record.choices) ? record.choices.map(mapChoice) : [],
      state: record.state ?? "pending"
    };
  }
  if (type === "approval.resolved") {
    return {
      ...record,
      approvalId: record.approvalId ?? record.approvalKey
    };
  }
  return record;
}

export function decodeLegacyEvent(input: unknown): Event | undefined {
  if (!input || typeof input !== "object") return undefined;
  const event = input as Partial<LegacyEvent>;
  if (event.contract !== LEGACY_EVENT_VERSION || !event.topic || !event.scope?.sessionKey) return undefined;
  if (event.topic === "cycle.executing" || event.topic.startsWith("context.compaction.")) return undefined;
  const type = TYPE_MAP[event.topic];
  if (!type) return undefined;
  return {
    at: String(event.emittedAt ?? ""),
    data: mapData(event as LegacyEvent, type),
    eventId: String(event.signalKey ?? `${event.scope.sessionKey}:${event.offset ?? 0}`),
    offset: Number(event.offset ?? 0),
    scope: {
      activityId: event.scope.unitKey,
      runId: event.scope.cycleKey,
      sessionId: event.scope.sessionKey
    },
    type,
    version: EVENT_VERSION
  };
}

export function decodeEvent(input: unknown): Event | undefined {
  if (!input || typeof input !== "object") return undefined;
  const event = input as Omit<Partial<Event>, "type"> & { contract?: string; type?: string };
  if (event.version === EVENT_VERSION) {
    if (event.type === "plan.changed") {
      return { ...event, data: mapTasks(event.data), type: "tasks.changed" } as Event;
    }
    if (event.type === "tasks.changed") {
      return { ...event, data: mapTasks(event.data) } as Event;
    }
    return event as Event;
  }
  return decodeLegacyEvent(input);
}

export function decodeStoredSession(input: unknown): Session {
  type StoredResume = NonNullable<Session["runs"][number]["resume"]> & { plan?: unknown[]; tasks?: unknown[] };
  type StoredRun = Omit<Session["runs"][number], "mode" | "tasks"> & {
    mode?: Session["mode"];
    plan?: unknown[];
    tasks?: unknown[];
    resume?: StoredResume;
  };
  const source = input as Omit<Session, "mode" | "planEntry" | "plans" | "questions" | "runs" | "workspaceKind"> & {
    mode?: Session["mode"];
    planEntry?: Session["planEntry"];
    plans?: Session["plans"];
    questions?: Session["questions"];
    runs?: StoredRun[];
    workspaceKind?: Session["workspaceKind"];
  };
  return {
    ...source,
    mode: source.mode ?? "work",
    planEntry: source.planEntry ?? "suggest",
    plans: source.plans ?? [],
    questions: source.questions ?? [],
    workspaceKind: source.workspaceKind ?? "project",
    runs: (source.runs ?? []).map((run) => ({
      ...run,
      mode: run.mode ?? source.mode ?? "work",
      resume: run.resume ? {
        ...run.resume,
        mode: run.resume.mode ?? run.mode ?? source.mode ?? "work",
        tasks: (mapTasks({ items: run.resume.tasks ?? run.resume.plan ?? [] }) as { items: Task[] }).items
      } : undefined,
      tasks: (mapTasks({ items: run.tasks ?? run.plan ?? [] }) as { items: Task[] }).items
    }))
  };
}
