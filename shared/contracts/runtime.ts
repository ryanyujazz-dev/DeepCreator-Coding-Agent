export const EVENT_VERSION = "deepseeker.events/v2" as const;

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type ActivityStatus = "running" | "suspended" | "completed" | "failed" | "cancelled";
export type Audience = "user" | "debug" | "internal";
export type Mode = "work" | "plan";
export type PlanEntry = "manual" | "suggest" | "auto";

export type ActivityKind =
  | "thinking"
  | "message"
  | "plan"
  | "tool"
  | "command"
  | "file_mutation"
  | "compaction"
  | "error";

export type ActionKind = "inspect" | "search" | "modify" | "execute" | "verify" | "task" | "plan" | "external";
export type TargetKind = "file" | "directory" | "workspace" | "process" | "network" | "task" | "plan";
export type Effect = "read_only" | "workspace_write" | "process_side_effect" | "external_side_effect" | "control_only";
export type GroupMode = "consecutive" | "same_model_step" | "standalone" | "workspace_delta";
export type ToolImportance = "routine" | "notable" | "critical";

export type DetailMode = {
  defaultCollapsed: boolean;
  pathStyle: "workspace_relative" | "raw";
  previewLimit: number;
};

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
  modelStepId: string;
  toolName: string;
  action: ActionKind;
  targetKind: TargetKind;
  effect: Effect;
  groupMode: GroupMode;
  importance: ToolImportance;
  normalizedTarget: string;
  displayTarget: string;
  argumentsPreview: string;
  detail: DetailMode;
  resultSummary?: string;
  resultMetrics?: ToolMetrics;
};

export type EventType =
  | "session.created"
  | "session.updated"
  | "mode.changed"
  | "run.started"
  | "tasks.changed"
  | "plan.proposed"
  | "plan.revised"
  | "plan.approved"
  | "plan.rejected"
  | "question.asked"
  | "question.answered"
  | "changes.changed"
  | "usage.changed"
  | "activity.started"
  | "activity.updated"
  | "activity.finished"
  | "approval.requested"
  | "approval.resolved"
  | "run.finished";

export type EventScope = {
  sessionId: string;
  runId?: string;
  activityId?: string;
};

export type Event<T = unknown> = {
  version: typeof EVENT_VERSION;
  eventId: string;
  offset: number;
  type: EventType;
  scope: EventScope;
  at: string;
  data: T;
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

export type QuestionPrompt = {
  questionId: string;
  label: string;
  prompt: string;
  options?: string[];
};

export type Question = {
  interactionId: string;
  sessionId: string;
  runId: string;
  callId: string;
  prompts: QuestionPrompt[];
  purpose?: "clarification" | "plan_entry";
  status: "pending" | "answered" | "cancelled";
  answers?: Record<string, string>;
  createdAt: string;
  resolvedAt?: string;
};

export type AccessMode = "request_approval" | "smart_approval" | "full_access";
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
  kind: ActivityKind;
  status: ActivityStatus;
  audience: Audience;
  title: string;
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
  error?: string;
};

export type DetailKind = "read" | "search" | "list" | "modify" | "verify" | "execute" | "task" | "plan" | "external";

export type DetailRow = {
  detailId: string;
  kind: DetailKind;
  label: string;
  targets: string[];
  totalCalls: number;
};

export type ActivityGroup = {
  groupId: string;
  runId: string;
  category: ActionKind;
  status: ActivityStatus;
  memberActivityIds: string[];
  totalCalls: number;
  successCount: number;
  failureCount: number;
  uniqueTargets: string[];
  currentTarget?: string;
  startedAt: string;
  finishedAt?: string;
  summaryLabel: string;
  detailRows: DetailRow[];
  importance: ToolImportance;
  defaultExpanded: boolean;
  changes?: Pick<Changes, "additions" | "deletions" | "fileCount">;
};

export type LiveStep =
  | { mode: "thinking"; activity: Activity }
  | { mode: "message"; activity: Activity }
  | {
      mode: "tools";
      category: ActionKind | "mixed";
      currentTarget?: string;
      status: ActivityStatus;
      summaryLabel: string;
      totalCalls: number;
    };

export type ActivityIndicator =
  | {
      mode: "thinking";
      sourceActivityId: string;
      label: string;
    }
  | {
      mode: "tool";
      sourceActivityId: string;
      category: ActionKind;
      label: string;
      target?: string;
    };

export type ActivitySlot = {
  slotId: string;
  logicalState: "active" | "empty";
  visual: ActivityIndicator;
};

export type ToolAggregate = {
  aggregateId: string;
  runId: string;
  memberActivityIds: string[];
  totalCalls: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  status: Exclude<ActivityStatus, "running">;
  summaryLabel: string;
};

export type DisplaySegment = {
  segmentId: string;
  runId: string;
  mainActivity?: Activity;
  aggregate?: ToolAggregate;
  activitySlots: ActivitySlot[];
};

export type DisplayTimelineEntry =
  | { entryId: string; type: "display_segment"; segment: DisplaySegment }
  | { entryId: string; type: "activity"; activity: Activity };

export type TimelineEntry =
  | DisplayTimelineEntry
  | { entryId: string; type: "activity_group"; group: ActivityGroup }
  | { entryId: string; type: "live_step"; liveStep: LiveStep };

export type Run = {
  runId: string;
  sessionId: string;
  prompt: string;
  model: string;
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
  answer: string;
  error?: string;
  resume?: ResumeState;
  lastOffset: number;
};

export type Session = {
  sessionId: string;
  title: string;
  model: string;
  mode: Mode;
  planEntry: PlanEntry;
  plans: Plan[];
  questions: Question[];
  projectRoot: string;
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
  lastOffset: number;
};

export type SessionInput = Pick<
  Session,
  "sessionId" | "title" | "model" | "projectRoot" | "createdAt" | "contextWindowTokens" | "compactThresholdTokens"
> & { accessMode?: AccessMode; mode?: Mode; planEntry?: PlanEntry };

export type SessionSummary = Pick<
  Session,
  "sessionId" | "title" | "model" | "projectRoot" | "createdAt" | "updatedAt"
> & {
  runCount: number;
  active: boolean;
};

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
