import { ActionKind, Activity, ActivityStatus, AggregateHeadlineKind, Changes, Run } from "../contracts/runtime";

export type GroupMode = "consecutive" | "same_model_step" | "standalone" | "workspace_delta";
export type ToolImportance = "routine" | "notable" | "critical";

export type DetailMode = {
  defaultCollapsed: boolean;
  pathStyle: "workspace_relative" | "raw";
  previewLimit: number;
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
  | { mode: "thinking"; sourceActivityId: string; label: string }
  | { mode: "tool"; sourceActivityId: string; category: ActionKind; label: string; target?: string };

export type ActivitySlot = {
  slotId: string;
  logicalState: "active" | "empty";
  visual: ActivityIndicator;
};

export type ToolAggregate = {
  aggregateId: string;
  headlineKind: AggregateHeadlineKind;
  headlineLabel: string;
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

export type RunTimelineModel = Pick<Run, "runId" | "status" | "changes" | "activities">;
