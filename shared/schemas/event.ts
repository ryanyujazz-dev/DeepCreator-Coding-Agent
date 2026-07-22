import {
  EVENT_VERSION,
  Event,
  EventPayloadMap,
  EventScope,
  EventType
} from "../contracts/runtime";

type RecordValue = Record<string, unknown>;
type PayloadValidator<K extends EventType> = (value: unknown) => boolean;

export type EventSchemaIssue = {
  path: string;
  message: string;
};

export type EventSchemaResult =
  | { success: true; value: Event }
  | { success: false; issues: EventSchemaIssue[] };

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optional(value: unknown, predicate: (input: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return string(value) && values.includes(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function task(value: unknown): boolean {
  return record(value)
    && string(value.taskId)
    && string(value.label)
    && oneOf(value.status, ["pending", "running", "completed", "blocked"] as const);
}

function plan(value: unknown): boolean {
  return record(value)
    && string(value.planId)
    && string(value.sessionId)
    && string(value.runId)
    && string(value.callId)
    && number(value.revision)
    && oneOf(value.status, ["draft", "proposed", "approved", "rejected", "superseded"] as const)
    && string(value.title)
    && string(value.markdown)
    && string(value.createdAt)
    && string(value.updatedAt);
}

function question(value: unknown): boolean {
  return record(value)
    && string(value.interactionId)
    && string(value.sessionId)
    && string(value.runId)
    && string(value.callId)
    && Array.isArray(value.prompts)
    && value.prompts.every((prompt) => record(prompt)
      && string(prompt.questionId)
      && string(prompt.label)
      && string(prompt.prompt)
      && optional(prompt.options, strings))
    && oneOf(value.status, ["pending", "answered", "cancelled"] as const)
    && string(value.createdAt);
}

function fileChange(value: unknown): boolean {
  return record(value)
    && string(value.path)
    && number(value.additions)
    && number(value.deletions)
    && oneOf(value.operation, ["created", "edited", "deleted", "renamed", "unknown"] as const);
}

function toolState(value: unknown, partial = false): boolean {
  if (!record(value)) return false;
  const required = (key: string, predicate: (input: unknown) => boolean) => partial
    ? optional(value[key], predicate)
    : predicate(value[key]);
  return required("callId", string)
    && required("modelStepId", string)
    && required("toolName", string)
    && required("action", (item) => oneOf(item, ["inspect", "search", "modify", "execute", "verify", "external", "task", "plan"] as const))
    && required("targetKind", (item) => oneOf(item, ["file", "directory", "workspace", "process", "network", "task", "plan"] as const))
    && required("effect", (item) => oneOf(item, ["read_only", "workspace_write", "process_side_effect", "external_side_effect", "control_only"] as const))
    && required("normalizedTarget", string)
    && required("argumentsPreview", string)
    && optional(value.resultSummary, string)
    && optional(value.resultMetrics, record)
    && optional(value.displayTarget, string)
    && optional(value.groupMode, (item) => oneOf(item, ["consecutive", "same_model_step", "standalone", "workspace_delta"] as const))
    && optional(value.importance, (item) => oneOf(item, ["routine", "notable", "critical"] as const))
    && optional(value.detail, record);
}

function command(value: unknown, partial = false): boolean {
  if (!record(value)) return false;
  return (partial ? optional(value.command, string) : string(value.command))
    && optional(value.commandId, string)
    && optional(value.elapsedMs, number)
    && optional(value.exitCode, number)
    && optional(value.outputTruncated, (item) => typeof item === "boolean")
    && optional(value.state, (item) => oneOf(item, ["running", "completed", "failed", "cancelled"] as const))
    && optional(value.timedOut, (item) => typeof item === "boolean");
}

function approval(value: unknown): boolean {
  return record(value)
    && string(value.approvalId)
    && string(value.callId)
    && oneOf(value.capability, ["workspace_write", "workspace_delete", "shell_execute", "network_access", "external_access"] as const)
    && string(value.target)
    && oneOf(value.risk, ["low", "medium", "high", "critical"] as const)
    && string(value.title)
    && string(value.detail)
    && Array.isArray(value.choices)
    && value.choices.every((choice) => oneOf(choice, ["allow_once", "allow_run", "allow_session", "deny"] as const))
    && oneOf(value.state, ["pending", "allowed", "denied", "dismissed"] as const);
}

const payloadSchemas = {
  "session.created": (value) => record(value)
    && string(value.sessionId)
    && string(value.title)
    && string(value.model)
    && string(value.projectRoot)
    && string(value.createdAt)
    && number(value.contextWindowTokens)
    && number(value.compactThresholdTokens),
  "session.updated": (value) => record(value)
    && optional(value.accessMode, (item) => oneOf(item, ["request_approval", "smart_approval", "full_access"] as const))
    && optional(value.compactSummary, string)
    && optional(value.contextTokens, number)
    && optional(value.grants, Array.isArray)
    && optional(value.planEntry, (item) => oneOf(item, ["manual", "suggest", "auto"] as const)),
  "mode.changed": (value) => record(value)
    && oneOf(value.mode, ["work", "plan"] as const)
    && optional(value.previousMode, (item) => oneOf(item, ["work", "plan"] as const))
    && optional(value.reason, string)
    && optional(value.source, (item) => oneOf(item, ["user", "model", "runtime"] as const)),
  "run.started": (value) => record(value)
    && string(value.model)
    && string(value.prompt)
    && string(value.startedAt)
    && optional(value.mode, (item) => oneOf(item, ["work", "plan"] as const)),
  "tasks.changed": (value) => record(value) && Array.isArray(value.items) && value.items.every(task),
  "plan.proposed": (value) => record(value) && plan(value.plan),
  "plan.revised": (value) => record(value) && plan(value.plan),
  "plan.approved": (value) => record(value)
    && string(value.approvedAt)
    && string(value.planId)
    && number(value.revision),
  "plan.rejected": (value) => record(value)
    && oneOf(value.decision, ["continue_planning", "cancel"] as const)
    && string(value.planId)
    && string(value.resolvedAt)
    && number(value.revision)
    && optional(value.comments, string),
  "question.asked": (value) => record(value) && question(value.question),
  "question.answered": (value) => record(value)
    && string(value.interactionId)
    && string(value.resolvedAt)
    && oneOf(value.status, ["pending", "answered", "cancelled"] as const)
    && optional(value.answers, record),
  "changes.changed": (value) => record(value)
    && number(value.fileCount)
    && number(value.additions)
    && number(value.deletions)
    && Array.isArray(value.files)
    && value.files.every(fileChange),
  "usage.changed": (value) => record(value)
    && oneOf(value.source, ["provider", "estimated"] as const)
    && optional(value.contextTokens, number)
    && optional(value.inputTokens, number)
    && optional(value.outputTokens, number),
  "activity.started": (value) => record(value)
    && oneOf(value.kind, ["thinking", "message", "plan", "tool", "command", "file_mutation", "compaction", "error"] as const)
    && oneOf(value.audience, ["user", "debug", "internal"] as const)
    && optional(value.title, string)
    && string(value.startedAt)
    && optional(value.body, string)
    && optional(value.tool, (item) => toolState(item))
    && optional(value.command, (item) => command(item))
    && optional(value.files, (item) => Array.isArray(item) && item.every(fileChange)),
  "activity.updated": (value) => record(value)
    && optional(value.argumentsDelta, string)
    && optional(value.bodyDelta, string)
    && optional(value.command, (item) => command(item, true))
    && optional(value.files, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.liveFiles, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.kind, (item) => oneOf(item, ["thinking", "message", "plan", "tool", "command", "file_mutation", "compaction", "error"] as const))
    && optional(value.status, (item) => oneOf(item, ["running", "suspended"] as const))
    && optional(value.title, string)
    && optional(value.tool, (item) => toolState(item, true)),
  "activity.finished": (value) => record(value)
    && string(value.finishedAt)
    && oneOf(value.status, ["running", "suspended", "completed", "failed", "cancelled"] as const)
    && optional(value.body, string)
    && optional(value.error, string)
    && optional(value.title, string)
    && optional(value.tool, (item) => toolState(item))
    && optional(value.command, (item) => command(item))
    && optional(value.files, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.liveFiles, (item) => Array.isArray(item) && item.every(fileChange)),
  "approval.requested": approval,
  "approval.resolved": (value) => record(value)
    && string(value.approvalId)
    && oneOf(value.state, ["pending", "allowed", "denied", "dismissed"] as const),
  "run.finished": (value) => record(value)
    && string(value.finishedAt)
    && oneOf(value.status, ["completed", "failed", "cancelled"] as const)
    && optional(value.answer, string)
    && optional(value.error, string)
} satisfies { [K in EventType]: PayloadValidator<K> };

const eventTypes = new Set<EventType>(Object.keys(payloadSchemas) as EventType[]);

function scope(value: unknown): value is EventScope {
  return record(value)
    && string(value.sessionId)
    && optional(value.runId, string)
    && optional(value.activityId, string);
}

/** Runtime schema for persisted and transported V2 Events. */
export const eventSchema = {
  safeParse(input: unknown): EventSchemaResult {
    const issues: EventSchemaIssue[] = [];
    if (!record(input)) return { success: false, issues: [{ path: "$", message: "Event must be an object." }] };
    if (input.version !== EVENT_VERSION) issues.push({ path: "version", message: `Expected ${EVENT_VERSION}.` });
    if (!string(input.eventId) || !input.eventId) issues.push({ path: "eventId", message: "Expected a non-empty string." });
    if (!number(input.offset) || !Number.isInteger(input.offset) || input.offset < 0) issues.push({ path: "offset", message: "Expected a non-negative integer." });
    if (!string(input.at)) issues.push({ path: "at", message: "Expected a timestamp string." });
    if (!scope(input.scope)) issues.push({ path: "scope", message: "Expected a valid Event scope." });
    if (!string(input.type) || !eventTypes.has(input.type as EventType)) {
      issues.push({ path: "type", message: "Unknown Event type." });
    } else {
      const type = input.type as EventType;
      const validate = payloadSchemas[type] as (value: unknown) => boolean;
      if (!validate(input.data)) issues.push({ path: "data", message: `Invalid payload for ${type}.` });
      if (type !== "session.created" && type !== "session.updated" && type !== "mode.changed" && !record(input.scope)) {
        issues.push({ path: "scope", message: `${type} requires a Run scope.` });
      } else if (type !== "session.created" && type !== "session.updated" && type !== "mode.changed" && !string((input.scope as RecordValue).runId)) {
        issues.push({ path: "scope.runId", message: `${type} requires runId.` });
      }
      if (type.startsWith("activity.") && record(input.scope) && !string(input.scope.activityId)) {
        issues.push({ path: "scope.activityId", message: `${type} requires activityId.` });
      }
    }
    return issues.length > 0 ? { success: false, issues } : { success: true, value: input as Event };
  },

  parse(input: unknown): Event {
    const result = this.safeParse(input);
    if (result.success) return result.value;
    throw new Error(`Invalid Event: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
};
