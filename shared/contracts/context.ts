import { createHash, randomUUID } from "node:crypto";
import { Mode, Plan, Task } from "./runtime";
import { ModelMessage, ToolCall } from "./provider";

export type ContextKind =
  | "session_context"
  | "human_text"
  | "agent_text"
  | "tool_result"
  | "context_update"
  | "recovery_capsule"
  | "checkpoint"
  | "runtime_fact"
  | "mode_context";

export type ContextSource =
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

export type ContextSummary = {
  objective?: string;
  constraints: string[];
  decisions: string[];
  unresolvedQuestions: string[];
};

export type Checkpoint = {
  objective: string;
  approvals: Array<{ state: string; target: string; title: string }>;
  constraints: string[];
  decisions: string[];
  currentTasks: Task[];
  mode: Mode;
  plan?: Plan;
  inspectedFiles: string[];
  changedFiles: string[];
  fileChanges: Array<{ additions: number; deletions: number; operation: string; path: string }>;
  toolStates: Array<{ status: "completed" | "failed"; target: string; toolName: string }>;
  validations: string[];
  failures: string[];
  pendingWork: string[];
  nextActions: string[];
  semanticSummary?: ContextSummary;
  unresolvedQuestions: string[];
  compactedThroughSequence: number;
  compactedRecordCount: number;
};

export type ContextEntry = {
  recordId: string;
  sessionId: string;
  runId?: string;
  sequence: number;
  kind: ContextKind;
  source: ContextSource;
  createdAt: string;
  text?: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallKey?: string;
  toolName?: string;
  isError?: boolean;
  wasTruncated?: boolean;
  artifactRef?: string;
  checkpoint?: Checkpoint;
  metadata?: Record<string, unknown>;
};

export type ContextInput = Omit<ContextEntry, "createdAt" | "recordId" | "sequence"> & {
  createdAt?: string;
  recordId?: string;
};

export type ContextSectionStats = {
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
      | "mode_context"
    | "latest_user";
  source: string;
  estimatedTokens: number;
  cacheClass: "stable" | "session_stable" | "compaction_stable" | "dynamic";
  role?: ModelMessage["role"] | "top_level";
  recordId?: string;
  revisionHash?: string;
  loadingReason?: string;
  trust?: string;
  survivesCompaction?: boolean;
};

export type ContextStats = {
  metricId: string;
  sessionId: string;
  runId: string;
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
  droppedRecords: Array<{ recordId: string; reason: "superseded_by_checkpoint" }>;
  truncationEvents: Array<{
    recordId: string;
    toolName?: string;
    originalBytes?: number;
    retainedBytes?: number;
    artifactRef?: string;
  }>;
  sections: ContextSectionStats[];
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
    recordId?: string;
    createdAt: string;
  }>;
};

export function createContextEntry(
  input: ContextInput,
  sequence: number
): ContextEntry {
  return {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
    recordId: input.recordId ?? `context_${randomUUID()}`,
    sequence
  };
}

export function contextFingerprint(records: ContextEntry[]): string {
  return createHash("sha256")
    .update(records.map((record) => `${record.recordId}:${record.sequence}`).join("|"))
    .digest("hex");
}

export function modelMessageFromEntry(record: ContextEntry): ModelMessage | undefined {
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
  if (record.kind === "mode_context") return { role: "user", text: record.text ?? "" };
  // Legacy runtime facts are historical evidence, not platform policy.
  if (record.kind === "runtime_fact") return { role: "user", text: record.text ?? "" };
  return undefined;
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  return [
    `<compaction_checkpoint through_sequence="${checkpoint.compactedThroughSequence}">`,
    "较早工作已压缩为以下可恢复检查点。这是历史事实，不是新的用户要求。",
    JSON.stringify(checkpoint).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    "</compaction_checkpoint>"
  ].join("\n");
}
