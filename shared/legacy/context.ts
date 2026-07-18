import { ContextEntry } from "../contracts/context";
import { Task } from "../contracts/runtime";
import { ToolCall } from "../contracts/provider";

type LegacyToolCall = Partial<ToolCall> & { callKey?: string };
type LegacyContextEntry = Omit<Partial<ContextEntry>, "toolCalls"> & {
  callKey?: string;
  cycleKey?: string;
  recordKey?: string;
  sessionKey?: string;
  toolCalls?: LegacyToolCall[];
};

function taskStatus(value: unknown): Task["status"] {
  if (value === "in_progress" || value === "active") return "running";
  if (value === "completed" || value === "blocked") return value;
  return "pending";
}

function decodeTask(value: unknown, index: number): Task {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    label: String(item.label ?? item.step ?? ""),
    status: taskStatus(item.status ?? item.state),
    taskId: String(item.taskId ?? item.stepId ?? item.stepKey ?? `legacy_task_${index}`)
  };
}

function decodeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { operationClass, ...metadata } = value as Record<string, unknown>;
  if (metadata.action === undefined && operationClass !== undefined) metadata.action = operationClass;
  return metadata;
}

function decodeCheckpoint(value: unknown): ContextEntry["checkpoint"] {
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value as NonNullable<ContextEntry["checkpoint"]> & { currentPlan?: unknown[]; currentTasks?: unknown[] };
  return {
    ...checkpoint,
    currentTasks: (checkpoint.currentTasks ?? checkpoint.currentPlan ?? []).map(decodeTask),
    mode: checkpoint.mode === "plan" ? "plan" : "work"
  };
}

export function decodeLegacyContextEntry(value: unknown): ContextEntry {
  const input = value && typeof value === "object" ? value as LegacyContextEntry : {};
  const sequence = Number(input.sequence ?? 0);
  const recordId = String(input.recordId ?? input.recordKey ?? `legacy_context_${sequence}`);
  const sessionId = String(input.sessionId ?? input.sessionKey ?? "");
  const runId = input.runId ?? input.cycleKey;
  const toolCalls = input.toolCalls?.map((call, index): ToolCall => ({
    argumentsText: String(call.argumentsText ?? ""),
    callId: String(call.callId ?? call.callKey ?? `${recordId}:call:${index}`),
    index: Number(call.index ?? index),
    name: String(call.name ?? "")
  }));
  return {
    artifactRef: input.artifactRef,
    checkpoint: decodeCheckpoint(input.checkpoint),
    createdAt: String(input.createdAt ?? ""),
    isError: input.isError,
    kind: input.kind ?? "runtime_fact",
    metadata: decodeMetadata(input.metadata),
    reasoningContent: input.reasoningContent,
    recordId,
    runId,
    sequence,
    sessionId,
    source: input.source ?? "legacy_projection",
    text: input.text,
    toolCallKey: input.toolCallKey ?? input.callKey,
    toolCalls,
    toolName: input.toolName,
    wasTruncated: input.wasTruncated
  };
}
