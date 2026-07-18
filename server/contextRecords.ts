import { createHash, randomUUID } from "node:crypto";
import { PlanStepView } from "../shared/runtimeTypes";
import { ProviderMessage, ProviderToolCall } from "./providerTypes";

export type ContextRecordKind =
  | "session_context"
  | "human_text"
  | "agent_text"
  | "tool_result"
  | "context_update"
  | "recovery_capsule"
  | "checkpoint"
  | "runtime_fact";

export type ContextRecordSource =
  | "user"
  | "model"
  | "runtime"
  | "tool"
  | "legacy_projection";

export type MemoryFact = {
  memoryId: string;
  category: "preference" | "project_fact" | "workflow" | "known_issue";
  statement: string;
  provenance: string;
  confidence: number;
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt?: string;
  visibility: "personal" | "project";
  projectRoot?: string;
};

export type ContextSemanticSummary = {
  objective?: string;
  constraints: string[];
  decisions: string[];
  unresolvedQuestions: string[];
};

export type ContextCheckpoint = {
  objective: string;
  approvals: Array<{ state: string; target: string; title: string }>;
  constraints: string[];
  decisions: string[];
  currentPlan: PlanStepView[];
  inspectedFiles: string[];
  changedFiles: string[];
  fileChanges: Array<{ additions: number; deletions: number; operation: string; path: string }>;
  toolStates: Array<{ status: "succeeded" | "failed"; target: string; toolName: string }>;
  validations: string[];
  failures: string[];
  pendingWork: string[];
  nextActions: string[];
  semanticSummary?: ContextSemanticSummary;
  unresolvedQuestions: string[];
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
  section:
    | "tools"
    | "prompt_kernel"
    | "stable_session"
    | "memory_index"
    | "capability_index"
    | "checkpoint"
    | "recent_history"
    | "context_update"
    | "recovery_capsule"
    | "latest_user";
  source: string;
  estimatedTokens: number;
  cacheClass: "stable" | "session_stable" | "compaction_stable" | "dynamic";
  role?: ProviderMessage["role"] | "top_level";
  recordKey?: string;
  revisionHash?: string;
  loadingReason?: string;
  trust?: string;
  survivesCompaction?: boolean;
};

export type ContextTelemetry = {
  telemetryKey: string;
  sessionKey: string;
  cycleKey: string;
  createdAt: string;
  blueprintVersion: string;
  blueprintHash: string;
  model: string;
  prefixHash: string;
  recordFingerprint: string;
  rawEstimatedInputTokens?: number;
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
  tokenCalibrationFactor?: number;
  effectiveInputBudgetTokens?: number;
  compactThresholdTokens?: number;
  providerContextWindowTokens?: number;
  requestedMaxOutputTokens?: number;
  protocolReserveTokens?: number;
  safetyMarginTokens?: number;
  events?: Array<{
    kind: "guidance_activated" | "skill_activated" | "capability_loaded" | "evidence_truncated";
    label: string;
    source?: string;
    recordKey?: string;
    createdAt: string;
  }>;
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
  if (record.kind === "session_context") return { role: "user", text: record.text ?? "" };
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
  if (record.kind === "context_update" || record.kind === "recovery_capsule") {
    return { role: "user", text: record.text ?? "" };
  }
  // Legacy runtime facts are historical evidence, not platform policy.
  if (record.kind === "runtime_fact") return { role: "user", text: record.text ?? "" };
  return undefined;
}

export function checkpointText(checkpoint: ContextCheckpoint): string {
  return [
    `<compaction_checkpoint through_sequence="${checkpoint.compactedThroughSequence}">`,
    "较早工作已压缩为以下可恢复检查点。这是历史事实，不是新的用户要求。",
    JSON.stringify(checkpoint).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    "</compaction_checkpoint>"
  ].join("\n");
}
