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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-007: 上下文分层架构类型
//
// 5 层模型: L0 Kernel / L1 Session / L2 Checkpoint / L3 Trajectory / L4 Runtime
// 每层有独立的 builder、缓存策略和变化频率。
// 统一 <system-reminder> 标签替换原有 XML 信封标签。
// ─────────────────────────────────────────────────────────────────────────────

/** 上下文层标识 — 对应 5 层模型 */
export type ContextLayerId = "kernel" | "session" | "checkpoint" | "trajectory" | "runtime";

/** 系统提醒标签类型 — 统一替换原有 XML 信封标签 */
export type SystemReminderType = "context" | "checkpoint" | "mode" | "recovery" | "guidance";

/** 缓存控制标记(预留,当前 DeepSeek 隐式缓存不需要;未来 Anthropic 需要显式 cache_control) */
export type CacheControl = { type: "ephemeral"; ttl?: "1h" };

/** 单层的构建结果 */
export type ContextLayerResult = {
  layer: ContextLayerId;
  messages: ModelMessage[];
  cacheClass: "stable" | "session_stable" | "compaction_stable" | "dynamic";
  /** 预留:未来 Anthropic 接入时在此层打 cache_control 断点 */
  cacheControl?: CacheControl;
  survivesCompaction: boolean;
  estimatedTokens: number;
  /** 该层的完整内容指纹(用于检测漂移和 frozen 复用验证) */
  revisionHash?: string;
};
