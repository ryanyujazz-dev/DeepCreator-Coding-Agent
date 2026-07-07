export type AgentRunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export type EventVisibility = "user" | "debug" | "hidden";

export type AgentEventType =
  | "run.started"
  | "model.stream.started"
  | "model.turn.started"
  | "model.reasoning.delta"
  | "model.content.delta"
  | "task.updated"
  | "tool.call.created"
  | "tool.execution.started"
  | "tool.output.delta"
  | "tool.execution.completed"
  | "tool.execution.failed"
  | "workspace.diff.updated"
  | "run.hud.updated"
  | "artifact.created"
  | "file.patch.applied"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ToolCallStatus = "queued" | "running" | "completed" | "failed";

export type AgentTaskStatus = "planned" | "in_progress" | "claimed_done" | "blocked";

export type RuntimeTaskStatus = "unverified" | "verified" | "failed" | "stale";

export type DisplayTaskStatus =
  | "待开始"
  | "进行中"
  | "待验证"
  | "已验证"
  | "已阻塞"
  | "验证失败";

export type VerificationRule =
  | {
      kind: "command_exit_zero";
      commandPattern: string;
    }
  | {
      kind: "file_changed";
      pathPattern: string;
    };

export type AgentTask = {
  id: string;
  title: string;
  agentStatus: AgentTaskStatus;
  runtimeStatus: RuntimeTaskStatus;
  displayStatus: DisplayTaskStatus;
  verification?: VerificationRule;
  evidenceRefs: string[];
};

export type ToolCallSnapshot = {
  id: string;
  name: string;
  label: string;
  status: ToolCallStatus;
  argumentsSummary: string;
};

export type DeepSeekTurnSnapshot = {
  id: string;
  reasoningSummary: string;
  content: string;
  toolCalls: ToolCallSnapshot[];
};

export type FilePatch = {
  path: string;
  additions: number;
  deletions: number;
};

export type DiffSummary = {
  changedFiles: number;
  additions: number;
  deletions: number;
  files: FilePatch[];
};

export type Artifact = {
  id: string;
  kind: "url" | "screenshot" | "build" | "audit";
  title: string;
  detail: string;
  href?: string;
};

export type Evidence = {
  id: string;
  kind: "command" | "file" | "git" | "model" | "tool";
  title: string;
  detail: string;
  status: AgentEventStatus;
  timestamp: string;
};

export type RunHUDState = {
  currentStep: number;
  totalSteps: number;
  currentStepTitle: string;
  status:
    | "idle"
    | "thinking"
    | "running_tool"
    | "editing"
    | "waiting_review"
    | "completed"
    | "failed"
    | "cancelled";
  changedFiles: number;
  additions: number;
  deletions: number;
};

export type AgentEvent = {
  id: string;
  type: AgentEventType;
  runId: string;
  turnId?: string;
  sequence: number;
  timestamp: string;
  visibility: EventVisibility;
  title: string;
  body?: string;
  status?: AgentEventStatus;
  meta?: {
    command?: string;
    commandCount?: number;
    exitCode?: number;
    fileCount?: number;
    tokenSource?: "reasoning_content" | "content" | "tool_calls" | "runtime";
    toolName?: string;
  };
};

export type AgentRun = {
  id: string;
  status: AgentRunStatus;
  title: string;
  model: string;
  elapsed: string;
  prompt: string;
  projectRoot?: string;
  startedAt?: string;
  completedAt?: string;
  turns: DeepSeekTurnSnapshot[];
  tasks: AgentTask[];
  hud: RunHUDState;
  diffSummary: DiffSummary;
  evidence: Evidence[];
  events: AgentEvent[];
  artifacts: Artifact[];
  patches: FilePatch[];
  finalAnswer: string[];
  verification: string[];
};

export type RunSnapshotMessage = {
  type: "snapshot";
  run: AgentRun;
};

export type RunErrorMessage = {
  type: "error";
  message: string;
};

export type RunStreamMessage = RunSnapshotMessage | RunErrorMessage;

export function deriveDisplayStatus(
  agentStatus: AgentTaskStatus,
  runtimeStatus: RuntimeTaskStatus
): DisplayTaskStatus {
  if (runtimeStatus === "failed") return "验证失败";
  if (runtimeStatus === "verified") return "已验证";
  if (agentStatus === "blocked") return "已阻塞";
  if (agentStatus === "claimed_done") return "待验证";
  if (agentStatus === "in_progress") return "进行中";
  return "待开始";
}

export function emptyDiffSummary(): DiffSummary {
  return {
    additions: 0,
    changedFiles: 0,
    deletions: 0,
    files: []
  };
}

export function createInitialHUD(): RunHUDState {
  return {
    additions: 0,
    changedFiles: 0,
    currentStep: 1,
    currentStepTitle: "准备运行",
    deletions: 0,
    status: "idle",
    totalSteps: 1
  };
}
