import { ModelCitation, ModelOutputItem, ModelProtocol } from "./provider";

export const EVENT_VERSION = "deepcreator.events/v2" as const;

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type ActivityStatus = "running" | "suspended" | "completed" | "failed" | "cancelled";
export type Audience = "user" | "debug" | "internal";
export type Mode = "work" | "plan";
export type PlanEntry = "manual" | "suggest" | "auto";

export type ActivityKind =
  | "thinking"
  | "message"
  | "user_message"
  | "plan"
  | "tool"
  | "command"
  | "file_mutation"
  | "delegation"
  | "compaction"
  | "error";

export type ActionKind = "inspect" | "search" | "modify" | "execute" | "verify" | "task" | "plan" | "external";
export type AggregateHeadlineKind =
  | "browse"
  | "locate"
  | "read"
  | "review"
  | "inspect_environment"
  | "modify"
  | "modify_and_verify"
  | "configure_environment"
  | "execute"
  | "verify"
  | "verify_runtime"
  | "build"
  | "install_dependencies"
  | "prepare_environment"
  | "start_service"
  | "start_database"
  | "initialize_database"
  | "external"
  | "deploy";
export type TargetKind = "file" | "directory" | "workspace" | "process" | "network" | "task" | "plan";
export type Effect = "read_only" | "workspace_write" | "process_side_effect" | "external_side_effect" | "control_only";
export type ToolMetrics = {
  byteCount?: number;
  exitCode?: number;
  itemCount?: number;
  matchCount?: number;
  timedOut?: boolean;
  truncated?: boolean;
};

export type ToolState = {
  callId: string;
  /** Stable ordering inside one sealed model step. */
  callIndex?: number;
  modelStepId: string;
  toolName: string;
  action: ActionKind;
  targetKind: TargetKind;
  effect: Effect;
  /** @deprecated Legacy presentation hint. New Events derive grouping in projections. */
  groupMode?: "consecutive" | "same_model_step" | "standalone" | "workspace_delta";
  /** @deprecated Legacy presentation hint. New Events derive importance in projections. */
  importance?: "routine" | "notable" | "critical";
  normalizedTarget: string;
  /** @deprecated Legacy rendered target. Use normalizedTarget as the durable fact. */
  displayTarget?: string;
  argumentsPreview: string;
  /** @deprecated Legacy expansion policy. New Events derive detail policy in the UI. */
  detail?: { defaultCollapsed: boolean; pathStyle: "workspace_relative" | "raw"; previewLimit: number };
  resultSummary?: string;
  resultMetrics?: ToolMetrics;
  /** Runtime-derived dominant work kind for the complete sealed model step. */
  stepHeadline?: AggregateHeadlineKind;
};

export type TaskStatus = "pending" | "running" | "completed" | "blocked";

export type Task = {
  taskId: string;
  label: string;
  status: TaskStatus;
};

export type PlanStatus = "draft" | "proposed" | "approved" | "rejected" | "superseded";

export type Plan = {
  planId: string;
  sessionId: string;
  runId: string;
  callId: string;
  revision: number;
  status: PlanStatus;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export type PlanDecision = "continue_planning" | "start_work" | "cancel";

export type QuestionType = "single_choice" | "multiple_choice" | "text";

export type QuestionOption = {
  optionId: string;
  title: string;
  description?: string;
  recommended?: boolean;
};

/**
 * `type`, structured options, and the input hints are the current contract.
 * `label` and string options remain readable so persisted pre-v2 questions can
 * be normalized without rewriting event history.
 */
export type QuestionPrompt = {
  questionId: string;
  prompt: string;
  type?: QuestionType;
  label?: string;
  options?: QuestionOption[] | string[];
  minSelections?: number;
  maxSelections?: number;
  placeholder?: string;
  multiline?: boolean;
};

export type QuestionAnswer =
  | {
      status: "answered";
      answer: {
        kind: "choice";
        optionIds: string[];
        customText?: string;
      };
    }
  | {
      status: "answered";
      answer: {
        kind: "text";
        text: string;
      };
    }
  | { status: "skipped" };

export type QuestionResolution = {
  interactionId: string;
  answers: Record<string, QuestionAnswer>;
};

export type Question = {
  interactionId: string;
  sessionId: string;
  runId: string;
  callId: string;
  prompts: QuestionPrompt[];
  purpose?: "clarification" | "plan_entry";
  status: "pending" | "answered" | "cancelled";
  answers?: Record<string, QuestionAnswer | string>;
  createdAt: string;
  resolvedAt?: string;
};

export type AccessMode = "request_approval" | "smart_approval" | "full_access";
export type AgentId = "explorer" | "worker";
export type SessionKind = "primary" | "subagent";
export type DelegationStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type DelegationDeliveryStatus = "pending" | "delivered";

export type Delegation = {
  agentId: AgentId;
  childRunId: string;
  childSessionId: string;
  createdAt: string;
  deliveryStatus: DelegationDeliveryStatus;
  delegationId: string;
  message: string;
  parentActivityId: string;
  parentCallId: string;
  parentRunId: string;
  parentSessionId: string;
  status: DelegationStatus;
  updatedAt: string;
  content?: string;
  error?: string;
  resultRecordId?: string;
};

export type DelegationActivity = Pick<Delegation,
  "agentId" | "childRunId" | "childSessionId" | "createdAt" | "delegationId" | "message" | "status" | "updatedAt"
> & Pick<Delegation, "content" | "error">;
export type ApprovalChoice = "allow_once" | "allow_run" | "allow_session" | "deny";
export type AccessScope = "workspace_write" | "workspace_delete" | "shell_execute" | "network_access" | "external_access";
export type AccessRisk = "low" | "medium" | "high" | "critical";

export type Grant = {
  grantId: string;
  toolName: string;
  capability: AccessScope;
  targetPattern: string;
  scope: "run" | "session";
  runId?: string;
  createdAt: string;
};

export type FileChange = {
  path: string;
  additions: number;
  deletions: number;
  operation: "created" | "edited" | "deleted" | "renamed" | "unknown";
  patch?: string;
};

export type Changes = {
  fileCount: number;
  additions: number;
  deletions: number;
  files: FileChange[];
  capturedAt?: string;
  comparisonBase?: "run_start" | "git_head";
};

// 产物文件(agent 生成的内容文件,扫描项目 output/ 目录)。按 projectRoot 跨会话共享。
export type ArtifactEntry = {
  path: string;       // 相对 output/ 的路径(含扩展名)
  size: number;       // 字节数
  mtime: string;      // ISO 时间戳
};

export type Usage = {
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  source: "provider" | "estimated";
};

export type Approval = {
  approvalId: string;
  callId: string;
  capability: AccessScope;
  target: string;
  risk: AccessRisk;
  title: string;
  detail: string;
  choices: ApprovalChoice[];
  state: "pending" | "allowed" | "denied" | "dismissed";
};

export type ResumeState = {
  capturedAt: string;
  projectRoot: string;
  failureType: "runtime_error" | "provider_protocol_error" | "interrupted" | "cancelled";
  failureMessage: string;
  tasks: Task[];
  mode: Mode;
  plan?: Plan;
  completedOperations: string[];
  interruptedOperations: string[];
  changedFiles: string[];
  lastProgress?: string;
};

export type Activity = {
  activityId: string;
  runId: string;
  modelStepId?: string;
  modelItemId?: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** 工具运行时子阶段:start(name 识别)→ generating_args(模型吐参数)→ executing(工程层执行)。
   *  仅工具 activity 用;前端折叠态不区分(统一"正在 X"),展开内容反映阶段。 */
  phase?: "generating_args" | "executing";
  audience: Audience;
  /** @deprecated Legacy rendered label. New Events derive labels in projections. */
  title?: string;
  body: string;
  startedAt: string;
  finishedAt?: string;
  tool?: ToolState;
  command?: {
    command: string;
    commandId?: string;
    elapsedMs?: number;
    exitCode?: number;
    outputTruncated?: boolean;
    state?: "running" | "completed" | "failed" | "cancelled";
    timedOut?: boolean;
  };
  files?: FileChange[];
  liveFiles?: FileChange[];
  citations?: ModelCitation[];
  draft?: {
    kind: "apply_patch";
    state: "generating" | "unapplied" | "waiting_approval" | "applying" | "applied" | "failed";
    text: string;
  };
  error?: string;
  delegation?: DelegationActivity;
};

export type Run = {
  runId: string;
  sessionId: string;
  prompt: string;
  model: string;
  protocol?: ModelProtocol;
  mode: Mode;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  activities: Activity[];
  tasks: Task[];
  planId?: string;
  changes: Changes;
  approvals: Approval[];
  usage?: Usage;
  outputItems?: ModelOutputItem[];
  /** Backward-compatible aggregate of all provider reasoning in this Run. */
  reasoning?: string;
  /** Provider reasoning grouped by sealed model step for the local Run inspector. */
  reasoningSteps?: ReasoningStep[];
  /** Latest model-generated progressive title for the reasoning inspector. */
  reasoningTitle?: string;
  answer: string;
  error?: string;
  resume?: ResumeState;
  lastOffset: number;
};

export type ReasoningStep = {
  modelStepId: string;
  text: string;
};

export type WorkspaceKind = "project" | "scratch";

export type FollowUp = {
  followUpId: string;
  prompt: string;
  createdAt: string;
  model: string;
  accessMode: AccessMode;
  mode: Mode;
  planEntry: PlanEntry;
  requestId?: string;
};

export type Session = {
  sessionId: string;
  title: string;
  model: string;
  mode: Mode;
  planEntry: PlanEntry;
  plans: Plan[];
  questions: Question[];
  followUps: FollowUp[];
  projectRoot: string;
  workspaceKind: WorkspaceKind;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  runs: Run[];
  contextTokens: number;
  contextWindowTokens: number;
  compactThresholdTokens: number;
  compactSummary?: string;
  accessMode: AccessMode;
  grants: Grant[];
  kind?: SessionKind;
  agentId?: AgentId;
  parentSessionId?: string;
  parentRunId?: string;
  originDelegationId?: string;
  delegations?: Delegation[];
  lastOffset: number;
};

export type SessionInput = Pick<
  Session,
  "sessionId" | "title" | "model" | "projectRoot" | "createdAt" | "contextWindowTokens" | "compactThresholdTokens"
> & {
  accessMode?: AccessMode;
  agentId?: AgentId;
  kind?: SessionKind;
  mode?: Mode;
  originDelegationId?: string;
  parentRunId?: string;
  parentSessionId?: string;
  planEntry?: PlanEntry;
  workspaceKind?: WorkspaceKind;
};

export type SessionSummary = Pick<
  Session,
  "sessionId" | "title" | "model" | "projectRoot" | "workspaceKind" | "createdAt" | "updatedAt"
> & {
  runCount: number;
  active: boolean;
  pinned?: boolean;
};

/** The single compile-time authority for each durable Event payload. */
export type EventPayloadMap = {
  "session.created": SessionInput;
  "session.updated": {
    accessMode?: AccessMode;
    compactSummary?: string;
    contextTokens?: number;
    grants?: Grant[];
    planEntry?: PlanEntry;
    title?: string;
  };
  "mode.changed": {
    mode: Mode;
    previousMode?: Mode;
    reason?: string;
    source?: "user" | "model" | "runtime";
  };
  "follow_up.queued": { followUp: FollowUp };
  "follow_up.removed": { followUpId: string };
  "delegation.created": { delegation: Delegation };
  "delegation.updated": {
    content?: string;
    delegationId: string;
    error?: string;
    resultRecordId?: string;
    status: DelegationStatus;
    updatedAt: string;
  };
  "delegation.delivered": { deliveredAt: string; delegationId: string };
  "run.started": Pick<Run, "model" | "prompt" | "startedAt"> & { mode?: Mode; protocol?: ModelProtocol };
  "model.output_item.changed": { item: ModelOutputItem };
  "reasoning.updated": {
    /** Optional only so pre-step-grouping Events remain replayable. */
    modelStepId?: string;
    textDelta: string;
  };
  "reasoning.title.updated": { title: string };
  "tasks.changed": { items: Task[] };
  "plan.proposed": { plan: Plan };
  "plan.revised": { plan: Plan };
  "plan.approved": { approvedAt: string; planId: string; revision: number };
  "plan.rejected": {
    comments?: string;
    decision: Extract<PlanDecision, "continue_planning" | "cancel">;
    planId: string;
    resolvedAt: string;
    revision: number;
  };
  "question.asked": { question: Question };
  "question.answered": {
    answers?: Record<string, QuestionAnswer | string>;
    interactionId: string;
    resolvedAt: string;
    status: Question["status"];
  };
  "changes.changed": Changes;
  "usage.changed": Usage;
  "activity.started": Omit<Activity, "activityId" | "body" | "runId" | "status"> & { body?: string };
  "activity.updated": {
    argumentsDelta?: string;
    bodyDelta?: string;
    command?: Partial<NonNullable<Activity["command"]>>;
    files?: Activity["files"];
    citations?: Activity["citations"];
    draft?: Activity["draft"];
    kind?: Activity["kind"];
    phase?: "generating_args" | "executing";
    liveFiles?: Activity["liveFiles"];
    status?: Extract<Activity["status"], "running" | "suspended">;
    title?: string;
    tool?: Partial<ToolState>;
  };
  "activity.finished": Partial<Activity> & {
    finishedAt: string;
    status: Activity["status"];
  };
  "approval.requested": Approval;
  "approval.resolved": Pick<Approval, "approvalId" | "state">;
  "run.finished": {
    answer?: string;
    error?: string;
    finishedAt: string;
    resume?: Run["resume"];
    status: Extract<RunStatus, "completed" | "failed" | "cancelled">;
  };
};

export type EventType = keyof EventPayloadMap;

export type EventScope = {
  sessionId: string;
  runId?: string;
  activityId?: string;
};

export type EventOf<K extends EventType> = {
  version: typeof EVENT_VERSION;
  eventId: string;
  offset: number;
  type: K;
  scope: EventScope;
  at: string;
  data: EventPayloadMap[K];
};

/** A discriminated union when K is omitted, and a precise Event for a known type. */
export type Event<K extends EventType = EventType> = K extends EventType ? EventOf<K> : never;

export type EventBatch = {
  kind: "events";
  sessionId: string;
  events: Event[];
};

export type HeartbeatMessage = {
  kind: "heartbeat";
  sessionId: string;
  offset: number;
};

export type EventStream = EventBatch | HeartbeatMessage;

export function emptyChanges(): Changes {
  return { additions: 0, comparisonBase: "run_start", deletions: 0, fileCount: 0, files: [] };
}

export function isRunDone(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
