export const SIGNAL_CONTRACT = "deepseeker.flow/v1" as const;

export type CyclePhase =
  | "queued"
  | "active"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type UnitPhase = "open" | "succeeded" | "failed" | "cancelled";
export type SignalAudience = "user" | "debug" | "internal";

export type ActivityKind =
  | "thinking"
  | "message"
  | "tool"
  | "command"
  | "file_mutation"
  | "compaction"
  | "error";

export type ToolOperationClass =
  | "inspect"
  | "search"
  | "modify"
  | "execute"
  | "verify"
  | "plan"
  | "external";

export type ToolResourceKind =
  | "file"
  | "directory"
  | "workspace"
  | "process"
  | "network"
  | "plan";

export type ToolEffectKind =
  | "read_only"
  | "workspace_write"
  | "process_side_effect"
  | "external_side_effect"
  | "control_only";

export type ToolAggregationPolicy =
  | "consecutive"
  | "same_model_step"
  | "standalone"
  | "workspace_delta";

export type ToolImportance = "routine" | "notable" | "critical";

export type ToolDetailPolicy = {
  defaultCollapsed: boolean;
  pathStyle: "workspace_relative" | "raw";
  previewLimit: number;
};

export type ToolResultMetrics = {
  byteCount?: number;
  exitCode?: number;
  itemCount?: number;
  matchCount?: number;
  truncated?: boolean;
};

export type ToolExecutionView = {
  callKey: string;
  modelStepKey: string;
  toolName: string;
  operationClass: ToolOperationClass;
  resourceKind: ToolResourceKind;
  effectKind: ToolEffectKind;
  aggregationPolicy: ToolAggregationPolicy;
  importance: ToolImportance;
  normalizedTarget: string;
  displayTarget: string;
  argumentsPreview: string;
  detailPolicy: ToolDetailPolicy;
  resultSummary?: string;
  resultMetrics?: ToolResultMetrics;
};

export type SignalTopic =
  | "session.registered"
  | "session.context.replaced"
  | "session.permissionProfile.changed"
  | "session.permissionGrants.replaced"
  | "cycle.accepted"
  | "cycle.executing"
  | "cycle.plan.replaced"
  | "cycle.workspaceDelta.replaced"
  | "cycle.usage.replaced"
  | "cycle.settled"
  | "unit.opened"
  | "unit.thinking.appended"
  | "unit.message.appended"
  | "unit.toolArguments.appended"
  | "unit.tool.updated"
  | "unit.commandOutput.appended"
  | "unit.sealed"
  | "interaction.approval.requested"
  | "interaction.approval.resolved"
  | "context.compaction.started"
  | "context.compaction.completed";

export type SignalScope = {
  sessionKey: string;
  cycleKey?: string;
  unitKey?: string;
};

export type AgentSignal<TPayload = unknown> = {
  contract: typeof SIGNAL_CONTRACT;
  signalKey: string;
  offset: number;
  topic: SignalTopic;
  scope: SignalScope;
  emittedAt: string;
  payload: TPayload;
};

export type PlanStepState = "pending" | "in_progress" | "completed" | "blocked";

export type PlanStepView = {
  stepKey: string;
  label: string;
  state: PlanStepState;
};

export type PermissionProfileKey = "request_approval" | "smart_approval" | "full_access";
export type ApprovalDecision = "allow_once" | "allow_cycle" | "allow_session" | "deny";
export type PermissionCapability =
  | "workspace_write"
  | "workspace_delete"
  | "shell_execute"
  | "network_access"
  | "external_access";
export type PermissionRisk = "low" | "medium" | "high" | "critical";

export type PermissionGrantView = {
  grantKey: string;
  toolName: string;
  capability: PermissionCapability;
  targetPattern: string;
  scope: "cycle" | "session";
  cycleKey?: string;
  createdAt: string;
};

export type FileDeltaView = {
  path: string;
  additions: number;
  deletions: number;
  operation: "created" | "edited" | "deleted" | "renamed" | "unknown";
  patch?: string;
};

export type WorkspaceDeltaView = {
  fileCount: number;
  additions: number;
  deletions: number;
  files: FileDeltaView[];
  capturedAt?: string;
  comparisonBase?: "cycle_start" | "git_head";
};

export type UsageView = {
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  source: "provider" | "estimated";
};

export type ApprovalView = {
  approvalKey: string;
  callKey: string;
  capability: PermissionCapability;
  target: string;
  risk: PermissionRisk;
  title: string;
  detail: string;
  choices: ApprovalDecision[];
  state: "pending" | "allowed" | "denied" | "dismissed";
};

export type RecoveryCapsule = {
  capturedAt: string;
  projectRoot: string;
  failureType: "runtime_error" | "provider_protocol_error" | "interrupted" | "cancelled";
  failureMessage: string;
  plan: PlanStepView[];
  completedOperations: string[];
  interruptedOperations: string[];
  changedFiles: string[];
  lastProgress?: string;
};

export type ActivityUnitView = {
  unitKey: string;
  cycleKey: string;
  kind: ActivityKind;
  phase: UnitPhase;
  audience: SignalAudience;
  title: string;
  body: string;
  openedAt: string;
  sealedAt?: string;
  tool?: ToolExecutionView;
  command?: {
    command: string;
    exitCode?: number;
  };
  files?: FileDeltaView[];
  error?: string;
};

export type OperationDetailKind =
  | "read"
  | "search"
  | "list"
  | "modify"
  | "verify"
  | "execute"
  | "plan"
  | "external";

export type OperationDetailRow = {
  detailKey: string;
  kind: OperationDetailKind;
  label: string;
  targets: string[];
  totalCalls: number;
};

export type OperationGroupView = {
  groupKey: string;
  cycleKey: string;
  category: ToolOperationClass;
  phase: UnitPhase;
  memberUnitKeys: string[];
  totalCalls: number;
  successCount: number;
  failureCount: number;
  uniqueTargets: string[];
  currentTarget?: string;
  startedAt: string;
  sealedAt?: string;
  summaryLabel: string;
  detailRows: OperationDetailRow[];
  importance: ToolImportance;
  defaultExpanded: boolean;
  workspaceDelta?: Pick<WorkspaceDeltaView, "additions" | "deletions" | "fileCount">;
};

export type TimelineProjectionEntry =
  | { entryKey: string; type: "operation_group"; group: OperationGroupView }
  | { entryKey: string; type: "activity_unit"; unit: ActivityUnitView };

export type CycleView = {
  cycleKey: string;
  sessionKey: string;
  prompt: string;
  model: string;
  phase: CyclePhase;
  startedAt: string;
  settledAt?: string;
  units: ActivityUnitView[];
  plan: PlanStepView[];
  workspaceDelta: WorkspaceDeltaView;
  approvals: ApprovalView[];
  usage?: UsageView;
  finalResponse: string;
  failure?: string;
  recovery?: RecoveryCapsule;
  lastOffset: number;
};

export type WorkspaceSessionView = {
  sessionKey: string;
  title: string;
  model: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  cycleKeys: string[];
  cycles: CycleView[];
  contextTokenEstimate: number;
  contextWindowTokens: number;
  compactThresholdTokens: number;
  compactSummary?: string;
  permissionProfile: PermissionProfileKey;
  permissionGrants: PermissionGrantView[];
  lastOffset: number;
};

export type SessionRegistration = Pick<
  WorkspaceSessionView,
  | "sessionKey"
  | "title"
  | "model"
  | "projectRoot"
  | "createdAt"
  | "contextWindowTokens"
  | "compactThresholdTokens"
> & { permissionProfile?: PermissionProfileKey };

export type SessionListEntry = Pick<
  WorkspaceSessionView,
  "sessionKey" | "title" | "model" | "projectRoot" | "createdAt" | "updatedAt"
> & {
  cycleCount: number;
  active: boolean;
};

export type SignalBatchMessage = {
  kind: "signals";
  sessionKey: string;
  signals: AgentSignal[];
};

export type HeartbeatMessage = {
  kind: "heartbeat";
  sessionKey: string;
  offset: number;
};

export type SignalStreamMessage = SignalBatchMessage | HeartbeatMessage;

export function emptyWorkspaceDelta(): WorkspaceDeltaView {
  return { additions: 0, comparisonBase: "cycle_start", deletions: 0, fileCount: 0, files: [] };
}

export function isTerminalCycle(phase: CyclePhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}
