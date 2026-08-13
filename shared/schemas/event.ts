import {
  EVENT_VERSION,
  Event,
  EventScope,
  EventType
} from "../contracts/runtime";

type RecordValue = Record<string, unknown>;
type PayloadValidator = (value: unknown) => boolean;

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

function task(value: unknown): boolean {
  return record(value)
    && string(value.taskId)
    && string(value.label)
    && oneOf(value.status, ["pending", "running", "completed", "blocked"] as const);
}

function followUp(value: unknown): boolean {
  return record(value)
    && string(value.followUpId)
    && string(value.prompt)
    && string(value.createdAt)
    && string(value.model)
    && oneOf(value.accessMode, ["request_approval", "smart_approval", "full_access"] as const)
    && oneOf(value.mode, ["work", "plan"] as const)
    && oneOf(value.planEntry, ["manual", "suggest", "auto"] as const)
    && optional(value.requestId, string);
}

function delegation(value: unknown): boolean {
  return record(value)
    && oneOf(value.agentId, ["explorer", "reviewer", "worker"] as const)
    && string(value.childRunId)
    && string(value.childSessionId)
    && string(value.createdAt)
    && oneOf(value.deliveryStatus, ["pending", "delivered"] as const)
    && string(value.delegationId)
    && string(value.message)
    && string(value.parentActivityId)
    && string(value.parentCallId)
    && string(value.parentRunId)
    && string(value.parentSessionId)
    && oneOf(value.status, ["running", "waiting", "completed", "failed", "cancelled"] as const)
    && string(value.updatedAt)
    && optional(value.content, string)
    && optional(value.error, string)
    && optional(value.resultRecordId, string);
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
      && string(prompt.prompt)
      && optional(prompt.label, string)
      && optional(prompt.type, (item) => oneOf(item, ["single_choice", "multiple_choice", "text"] as const))
      && optional(prompt.options, (items) => Array.isArray(items) && (
        items.every(string)
        || items.every((option) => record(option)
          && string(option.optionId)
          && string(option.title)
          && optional(option.description, string)
          && optional(option.recommended, (item) => typeof item === "boolean"))
      ))
      && optional(prompt.minSelections, number)
      && optional(prompt.maxSelections, number)
      && optional(prompt.placeholder, string)
      && optional(prompt.multiline, (item) => typeof item === "boolean"))
    && oneOf(value.status, ["pending", "answered", "cancelled"] as const)
    && string(value.createdAt)
    && optional(value.answers, record);
}

function fileChange(value: unknown): boolean {
  return record(value)
    && string(value.path)
    && number(value.additions)
    && number(value.deletions)
    && oneOf(value.operation, ["created", "edited", "deleted", "renamed", "unknown"] as const);
}

function citation(value: unknown): boolean {
  return record(value)
    && number(value.startIndex)
    && number(value.endIndex)
    && string(value.title)
    && string(value.url);
}

function patchDraft(value: unknown): boolean {
  return record(value)
    && value.kind === "apply_patch"
    && oneOf(value.state, ["generating", "unapplied", "waiting_approval", "applying", "applied", "failed"] as const)
    && string(value.text);
}

function modelOutputItem(value: unknown): boolean {
  return record(value)
    && string(value.itemId)
    && string(value.modelStepId)
    && number(value.outputIndex)
    && number(value.sequence)
    && oneOf(value.status, ["generating", "running", "completed", "failed"] as const)
    && oneOf(value.type, ["reasoning", "message", "function", "custom", "hosted_tool"] as const)
    && optional(value.argumentsText, string)
    && optional(value.callId, string)
    && optional(value.citations, (item) => Array.isArray(item) && item.every(citation))
    && optional(value.draft, string)
    && optional(value.error, string)
    && optional(value.searchQuery, string)
    && optional(value.searchStatus, (item) => oneOf(item, ["in_progress", "searching", "completed"] as const))
    && optional(value.text, string)
    && optional(value.toolName, string);
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
    && optional(value.callIndex, number)
    && optional(value.resultSummary, string)
    && optional(value.resultMetrics, record)
    && optional(value.stepHeadline, (item) => oneOf(item, [
      "browse",
      "locate",
      "read",
      "review",
      "inspect_environment",
      "modify",
      "modify_and_verify",
      "configure_environment",
      "execute",
      "verify",
      "verify_runtime",
      "build",
      "install_dependencies",
      "prepare_environment",
      "start_service",
      "start_database",
      "initialize_database",
      "external",
      "deploy"
    ] as const))
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
    && number(value.compactThresholdTokens)
    && optional(value.kind, (item) => oneOf(item, ["primary", "subagent"] as const))
    && optional(value.agentId, (item) => oneOf(item, ["explorer", "reviewer", "worker"] as const))
    && optional(value.parentSessionId, string)
    && optional(value.parentRunId, string)
    && optional(value.originDelegationId, string),
  "session.updated": (value) => record(value)
    && optional(value.accessMode, (item) => oneOf(item, ["request_approval", "smart_approval", "full_access"] as const))
    && optional(value.compactSummary, string)
    && optional(value.contextTokens, number)
    && optional(value.grants, Array.isArray)
    && optional(value.planEntry, (item) => oneOf(item, ["manual", "suggest", "auto"] as const))
    && optional(value.title, string),
  "mode.changed": (value) => record(value)
    && oneOf(value.mode, ["work", "plan"] as const)
    && optional(value.previousMode, (item) => oneOf(item, ["work", "plan"] as const))
    && optional(value.reason, string)
    && optional(value.source, (item) => oneOf(item, ["user", "model", "runtime"] as const)),
  "follow_up.queued": (value) => record(value) && followUp(value.followUp),
  "follow_up.removed": (value) => record(value) && string(value.followUpId),
  "delegation.created": (value) => record(value) && delegation(value.delegation),
  "delegation.updated": (value) => record(value)
    && string(value.delegationId)
    && oneOf(value.status, ["running", "waiting", "completed", "failed", "cancelled"] as const)
    && string(value.updatedAt)
    && optional(value.content, string)
    && optional(value.error, string)
    && optional(value.resultRecordId, string),
  "delegation.delivered": (value) => record(value)
    && string(value.delegationId)
    && string(value.deliveredAt),
  "run.started": (value) => record(value)
    && string(value.model)
    && string(value.prompt)
    && string(value.startedAt)
    && optional(value.mode, (item) => oneOf(item, ["work", "plan"] as const))
    && optional(value.protocol, (item) => oneOf(item, ["chat", "responses"] as const)),
  "model.output_item.changed": (value) => record(value) && modelOutputItem(value.item),
  "reasoning.updated": (value) => record(value)
    && optional(value.modelStepId, string)
    && string(value.textDelta),
  "reasoning.title.updated": (value) => record(value)
    && string(value.title)
    && value.title.trim().length > 0
    && value.title.length <= 60,
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
    && oneOf(value.kind, ["thinking", "message", "user_message", "plan", "tool", "command", "file_mutation", "delegation", "compaction", "error"] as const)
    && oneOf(value.audience, ["user", "debug", "internal"] as const)
    && optional(value.title, string)
    && optional(value.modelStepId, string)
    && optional(value.modelItemId, string)
    && string(value.startedAt)
    && optional(value.body, string)
    && optional(value.tool, (item) => toolState(item))
    && optional(value.command, (item) => command(item))
    && optional(value.files, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.citations, (item) => Array.isArray(item) && item.every(citation))
    && optional(value.draft, patchDraft),
  "activity.updated": (value) => record(value)
    && optional(value.argumentsDelta, string)
    && optional(value.bodyDelta, string)
    && optional(value.command, (item) => command(item, true))
    && optional(value.files, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.citations, (item) => Array.isArray(item) && item.every(citation))
    && optional(value.draft, patchDraft)
    && optional(value.liveFiles, (item) => Array.isArray(item) && item.every(fileChange))
    && optional(value.kind, (item) => oneOf(item, ["thinking", "message", "user_message", "plan", "tool", "command", "file_mutation", "delegation", "compaction", "error"] as const))
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
    && optional(value.citations, (item) => Array.isArray(item) && item.every(citation))
    && optional(value.draft, patchDraft)
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
} satisfies { [K in EventType]: PayloadValidator };

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
      const sessionScoped = type === "session.created"
        || type === "session.updated"
        || type === "mode.changed"
        || type === "follow_up.queued"
        || type === "follow_up.removed"
        || type === "delegation.created"
        || type === "delegation.updated"
        || type === "delegation.delivered";
      if (!sessionScoped && !record(input.scope)) {
        issues.push({ path: "scope", message: `${type} requires a Run scope.` });
      } else if (!sessionScoped && !string((input.scope as RecordValue).runId)) {
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
