import { createHash, randomUUID } from "node:crypto";
import { PlanStepView } from "../shared/runtimeTypes";
import { ProviderMessage, ProviderToolCall } from "./providerTypes";

export type ContextRecordKind =
  | "human_text"
  | "agent_text"
  | "tool_result"
  | "runtime_fact"
  | "checkpoint";

export type ContextRecordSource =
  | "user"
  | "model"
  | "runtime"
  | "tool"
  | "legacy_projection";

export type ContextCheckpoint = {
  objective: string;
  constraints: string[];
  decisions: string[];
  currentPlan: PlanStepView[];
  inspectedFiles: string[];
  changedFiles: string[];
  validations: string[];
  failures: string[];
  pendingWork: string[];
  nextActions: string[];
  compactedThroughSequence: number;
  compactedRecordCount: number;
};

export type ContextRecord = {
  recordKey: string;
  sessionKey: string;
  cycleKey?: string;
  sequence: number;
  kind: ContextRecordKind;
  source: ContextRecordSource;
  createdAt: string;
  text?: string;
  reasoningContent?: string;
  toolCalls?: ProviderToolCall[];
  toolCallKey?: string;
  toolName?: string;
  isError?: boolean;
  wasTruncated?: boolean;
  artifactRef?: string;
  checkpoint?: ContextCheckpoint;
  metadata?: Record<string, unknown>;
};

export type NewContextRecord = Omit<ContextRecord, "createdAt" | "recordKey" | "sequence"> & {
  createdAt?: string;
  recordKey?: string;
};

export type ContextSectionMetric = {
  section: "tools" | "system" | "instructions" | "checkpoint" | "recent_history" | "runtime_context" | "latest_user";
  source: string;
  estimatedTokens: number;
  cacheClass: "stable" | "session_stable" | "compaction_stable" | "dynamic";
};

export type ContextTelemetry = {
  telemetryKey: string;
  sessionKey: string;
  cycleKey: string;
  createdAt: string;
  blueprintVersion: string;
  blueprintHash: string;
  prefixHash: string;
  recordFingerprint: string;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  compacted: boolean;
  compactedRecordCount: number;
  compactBeforeTokens?: number;
  compactAfterTokens?: number;
  retainedRecordCount: number;
  retainedRecordKeys: string[];
  droppedRecordCount: number;
  droppedRecords: Array<{ recordKey: string; reason: "superseded_by_checkpoint" }>;
  truncationEvents: Array<{
    recordKey: string;
    toolName?: string;
    originalBytes?: number;
    retainedBytes?: number;
    artifactRef?: string;
  }>;
  sections: ContextSectionMetric[];
};

export function createContextRecord(
  input: NewContextRecord,
  sequence: number
): ContextRecord {
  return {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
    recordKey: input.recordKey ?? `context_${randomUUID()}`,
    sequence
  };
}

export function contextRecordFingerprint(records: ContextRecord[]): string {
  return createHash("sha256")
    .update(records.map((record) => `${record.recordKey}:${record.sequence}`).join("|"))
    .digest("hex");
}

export function providerMessageFromRecord(record: ContextRecord): ProviderMessage | undefined {
  if (record.kind === "human_text") return { role: "user", text: record.text ?? "" };
  if (record.kind === "agent_text") {
    return {
      continuationThinking: record.toolCalls?.length ? record.reasoningContent : undefined,
      role: "assistant",
      text: record.text ?? null,
      toolCalls: record.toolCalls
    };
  }
  if (record.kind === "tool_result") {
    return { role: "tool", text: record.text ?? "", toolCallKey: record.toolCallKey };
  }
  if (record.kind === "runtime_fact") return { role: "system", text: record.text ?? "" };
  return undefined;
}

export function checkpointText(checkpoint: ContextCheckpoint): string {
  return [
    "较早工作已压缩为以下可恢复检查点。这是历史事实，不是新的用户要求。",
    JSON.stringify(checkpoint)
  ].join("\n");
}
