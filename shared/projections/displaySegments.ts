import {
  ActionKind,
  Activity,
  Run,
  ToolUseStatement
} from "../contracts/runtime";
import {
  ActivityIndicator,
  ActivitySlot,
  DisplayTimelineEntry,
  DisplaySegment,
  ToolAggregate
} from "./types";
import { activityTitle, toolDisplayTarget, toolTarget } from "./activityPresentation";

type IndexedActivity = {
  activity: Activity;
  index: number;
};

type SegmentDraft = {
  segmentId: string;
  runId: string;
  contentSeen: boolean;
  mainActivity?: Activity;
  transientBoundary: number;
  transients: IndexedActivity[];
  tools: Activity[];
  statement?: ToolUseStatement;
  statementGroupId?: string;
  statementOpen: boolean;
};

type DraftEntry =
  | { type: "display_segment"; draft: SegmentDraft }
  | { type: "activity"; activity: Activity };

type Transition = {
  activity: Activity;
  at: string;
  index: number;
  type: "start" | "finish";
};

export type DisplayProjectionOptions = {
  suppressedContentActivityIds?: ReadonlySet<string>;
};

function toolCategory(activity: Activity): ActionKind | undefined {
  const tool = activity.tool;
  if (!tool || tool.action === "task" || tool.action === "plan") return undefined;
  if (tool.action === "inspect" || tool.action === "search") return "inspect";
  return tool.action;
}

function isInternal(activity: Activity): boolean {
  return activity.audience === "internal"
    || activity.tool?.action === "task"
    || (activity.tool?.action === "plan" && activity.kind !== "plan");
}

function createDraft(activity: Activity): SegmentDraft {
  return {
    contentSeen: false,
    runId: activity.runId,
    segmentId: `display_segment:${activity.runId}:${activity.activityId}`,
    statementOpen: false,
    transientBoundary: 0,
    transients: [],
    tools: []
  };
}

function toolStartLabel(activity: Activity): string {
  const target = toolDisplayTarget(activity.tool) || activityTitle(activity);
  let action = "正在执行";
  if (activity.tool?.toolName === "read_file") action = "正在读取";
  else if (activity.tool?.toolName === "list_files") action = "正在列出";
  else if (activity.tool?.toolName === "grep") action = "正在搜索";
  else if (activity.tool?.toolName === "glob") action = "正在匹配";
  else if (activity.tool?.toolName === "write_file") action = "正在创建";
  else if (activity.tool?.toolName === "edit_file") action = "正在编辑";
  else if (activity.tool?.toolName === "delete_file") action = "正在删除";
  else if (activity.tool?.toolName === "run_command") action = "正在运行";
  else if (activity.tool?.action === "search") action = "正在搜索";
  else if (activity.tool?.action === "modify") action = "正在修改";
  else if (activity.tool?.action === "verify") action = "正在验证";
  return target ? `${action} ${target}` : action;
}

function indicatorFor(activity: Activity): ActivityIndicator {
  if (activity.kind === "thinking") {
    return { label: "正在思考", mode: "thinking", sourceActivityId: activity.activityId };
  }
  return {
    category: toolCategory(activity) ?? "external",
    label: toolStartLabel(activity),
    mode: "tool",
    sourceActivityId: activity.activityId,
    target: toolTarget(activity.tool) || undefined
  };
}

function compareTransitions(left: Transition, right: Transition): number {
  const time = left.at.localeCompare(right.at);
  if (time !== 0) return time;
  if (left.index === right.index && left.type !== right.type) return left.type === "start" ? -1 : 1;
  if (left.type !== right.type) return left.type === "finish" ? -1 : 1;
  return left.index - right.index;
}

function projectActivitySlots(transients: IndexedActivity[]): ActivitySlot[] {
  if (transients.length === 0) return [];
  // 规则:只要有任何工具正在调用(status === "running"),正在思考就让位给工具;
  // 工具结束后,思考可以重新回到活动槽位。
  const hasRunningTool = transients.some(
    (entry) => entry.activity.kind !== "thinking" && entry.activity.status === "running"
  );
  const filteredTransients = hasRunningTool
    ? transients.filter((entry) => entry.activity.kind !== "thinking")
    : transients;
  if (filteredTransients.length === 0) return [];
  const transitions: Transition[] = [];
  for (const transient of filteredTransients) {
    transitions.push({ activity: transient.activity, at: transient.activity.startedAt, index: transient.index, type: "start" });
    if (transient.activity.status !== "running") {
      transitions.push({
        activity: transient.activity,
        at: transient.activity.finishedAt ?? transient.activity.startedAt,
        index: transient.index,
        type: "finish"
      });
    }
  }
  transitions.sort(compareTransitions);

  const slots: ActivitySlot[] = [];
  const activitySlots = new Map<string, string>();
  for (const transition of transitions) {
    if (transition.type === "start") {
      const reusable = slots.find((slot) => slot.logicalState === "empty");
      const slot = reusable ?? {
        logicalState: "active" as const,
        slotId: `activity_slot:${transition.activity.activityId}`,
        visual: indicatorFor(transition.activity)
      };
      slot.logicalState = "active";
      slot.visual = indicatorFor(transition.activity);
      if (!reusable) slots.push(slot);
      activitySlots.set(transition.activity.activityId, slot.slotId);
      continue;
    }
    const slotId = activitySlots.get(transition.activity.activityId);
    activitySlots.delete(transition.activity.activityId);
    const slotIndex = slots.findIndex((slot) => slot.slotId === slotId);
    if (slotIndex < 0) continue;
    const otherActive = slots.some((slot, index) => index !== slotIndex && slot.logicalState === "active");
    if (otherActive) slots.splice(slotIndex, 1);
    else slots[slotIndex].logicalState = "empty";
  }
  const active = slots.filter((slot) => slot.logicalState === "active");
  if (active.length > 0) return active;
  return slots.slice(-1);
}

function aggregateBucket(activity: Activity): string {
  if (activity.tool?.toolName === "read_file") return "read";
  if (activity.tool?.toolName === "list_files") return "list";
  if (activity.tool?.action === "search") return "search";
  if (activity.tool?.action === "modify") return "modify";
  if (activity.tool?.action === "verify") return "verify";
  if (activity.tool?.toolName === "run_command" || activity.tool?.action === "execute") return "execute";
  if (activity.tool?.action === "external") return "external";
  return "inspect";
}

function uniqueObjectCount(activities: Activity[]): number {
  const targets = new Set(activities.map((activity) => activity.tool?.normalizedTarget).filter(Boolean));
  return targets.size || activities.length;
}

function bucketLabel(bucket: string, activities: Activity[]): string {
  const count = uniqueObjectCount(activities);
  if (bucket === "read") return `已读取 ${count} 个文件`;
  if (bucket === "list") return `已列出 ${count} 个目录`;
  if (bucket === "search") return `已搜索 ${count} 项`;
  if (bucket === "modify") return `已编辑 ${count} 个文件`;
  if (bucket === "verify") return `已完成 ${count} 项验证`;
  if (bucket === "execute") return `已运行 ${activities.length} 条命令`;
  if (bucket === "external") return `已完成 ${activities.length} 项外部调用`;
  return `已检查 ${count} 项`;
}

function projectAggregate(draft: SegmentDraft, runStatus: Run["status"]): ToolAggregate | undefined {
  const statement = draft.statement
    ?? draft.tools.find((activity) => activity.tool?.statement)?.tool?.statement;
  const settled = draft.tools.filter((activity) => activity.status !== "running");
  if (settled.length === 0 && !statement) return undefined;
  const buckets = new Map<string, Activity[]>();
  for (const activity of settled) {
    const bucket = aggregateBucket(activity);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), activity]);
  }
  const failureCount = settled.filter((activity) => activity.status === "failed").length;
  const cancelledCount = settled.filter((activity) => activity.status === "cancelled").length;
  const suffix = [
    failureCount > 0 ? `${failureCount} 项失败` : "",
    cancelledCount > 0 ? `${cancelledCount} 项已取消` : ""
  ].filter(Boolean).join(" · ");
  const status = (statement && draft.statementOpen && runStatus === "running")
    || draft.tools.some((activity) => activity.status === "running")
    ? "running"
    : failureCount > 0 ? "failed" : cancelledCount > 0 ? "cancelled" : "completed";
  const summary = [...buckets].map(([bucket, activities]) => bucketLabel(bucket, activities)).join(" · ");
  return {
    aggregateId: statement ? `tool_aggregate:${statement.groupId}` : `tool_aggregate:${draft.segmentId}`,
    cancelledCount,
    failureCount,
    groupId: statement?.groupId,
    memberActivityIds: (statement ? draft.tools : settled).map((activity) => activity.activityId),
    runId: draft.runId,
    statementId: statement?.statementId,
    status,
    successCount: settled.filter((activity) => activity.status === "completed").length,
    summaryLabel: suffix ? `${summary} · ${suffix}` : summary,
    title: statement?.title,
    totalCalls: statement ? draft.tools.length : settled.length
  };
}

function finishSegment(draft: SegmentDraft, runStatus: Run["status"]): DisplaySegment | undefined {
  const aggregate = projectAggregate(draft, runStatus);
  const activityById = new Map(draft.transients.map(({ activity }) => [activity.activityId, activity]));
  const activitySlots = projectActivitySlots(draft.transients.slice(draft.transientBoundary))
    .filter((slot) => {
      if (slot.logicalState !== "empty") return true;
      if (aggregate) return false;
      return activityById.get(slot.visual.sourceActivityId)?.status === "suspended";
    });
  if (!draft.mainActivity && !aggregate && activitySlots.length === 0) return undefined;
  return {
    activitySlots,
    aggregate,
    mainActivity: draft.mainActivity,
    runId: draft.runId,
    segmentId: draft.segmentId
  };
}

export function projectDisplayTimeline(
  run: Pick<Run, "runId" | "activities" | "status">,
  activities = run.activities,
  options: DisplayProjectionOptions = {}
): DisplayTimelineEntry[] {
  const entries: DraftEntry[] = [];
  let current: SegmentDraft | undefined;
  let initialThinkingSeen = false;
  let semanticProgressSeen = false;
  const statementGroupByModelStepId = new Map(
    activities.flatMap((activity) => {
      const modelStepId = activity.modelStepId ?? activity.tool?.modelStepId;
      const groupId = activity.tool?.statement?.groupId;
      return modelStepId && groupId ? [[modelStepId, groupId] as const] : [];
    })
  );

  const ensureSegment = (activity: Activity) => {
    if (current) return current;
    current = createDraft(activity);
    entries.push({ draft: current, type: "display_segment" });
    return current;
  };

  for (const [index, activity] of activities.entries()) {
    if (activity.kind === "statement" && activity.statement) {
      semanticProgressSeen = true;
      const statement = activity.statement;
      if (
        current
        && (
          current.contentSeen
          || (current.statementGroupId && current.statementGroupId !== statement.groupId)
          || (current.tools.length > 0 && !current.statementGroupId)
        )
      ) {
        current.statementOpen = false;
        current = createDraft(activity);
        entries.push({ draft: current, type: "display_segment" });
      }
      const segment = ensureSegment(activity);
      segment.statement = statement;
      segment.statementGroupId = statement.groupId;
      segment.statementOpen = true;
      continue;
    }
    if (isInternal(activity)) continue;
    if (activity.kind === "message") {
      semanticProgressSeen = true;
      if (current?.statementOpen) current.statementOpen = false;
      if (current && (current.contentSeen || current.tools.length > 0 || Boolean(current.statement))) {
        // The next content visually replaces the old activity slot while anchoring a new segment.
        current.transientBoundary = current.transients.length;
        current = createDraft(activity);
        entries.push({ draft: current, type: "display_segment" });
      } else if (!current) {
        current = createDraft(activity);
        entries.push({ draft: current, type: "display_segment" });
      }
      current.contentSeen = true;
      current.transientBoundary = current.transients.length;
      if (!options.suppressedContentActivityIds?.has(activity.activityId)) current.mainActivity = activity;
      continue;
    }
    if (activity.kind === "thinking") {
      if (semanticProgressSeen || initialThinkingSeen) continue;
      initialThinkingSeen = true;
      const modelStepId = activity.modelStepId;
      const statementGroupId = modelStepId ? statementGroupByModelStepId.get(modelStepId) : undefined;
      const previousToolStepId = current?.tools.at(-1)?.tool?.modelStepId;
      if (
        current
        && current.tools.length > 0
        && (
          (statementGroupId && current.statementGroupId !== statementGroupId)
          || (
            !current.statementGroupId
            && !statementGroupId
            && previousToolStepId !== modelStepId
          )
        )
      ) {
        current = createDraft(activity);
        entries.push({ draft: current, type: "display_segment" });
      }
      const segment = ensureSegment(activity);
      segment.statementGroupId ??= statementGroupId;
      segment.transients.push({ activity, index });
      continue;
    }
    if (toolCategory(activity)) {
      semanticProgressSeen = true;
      const statementGroupId = activity.tool?.statement?.groupId;
      if (
        current
        && current.tools.length > 0
        && (current.statementGroupId || statementGroupId)
        && current.statementGroupId !== statementGroupId
      ) {
        current.statementOpen = false;
        current = createDraft(activity);
        entries.push({ draft: current, type: "display_segment" });
      }
      const segment = ensureSegment(activity);
      segment.statement ??= activity.tool?.statement;
      segment.statementGroupId ??= statementGroupId;
      if (segment.statement) segment.statementOpen = true;
      segment.tools.push(activity);
      segment.transients.push({ activity, index });
      continue;
    }
    entries.push({ activity, type: "activity" });
  }

  if (run.status !== "running") {
    for (const entry of entries) {
      if (entry.type === "display_segment") entry.draft.statementOpen = false;
    }
  }

  return entries.flatMap<DisplayTimelineEntry>((entry) => {
    if (entry.type === "activity") {
      return [{ activity: entry.activity, entryId: entry.activity.activityId, type: "activity" }];
    }
    const segment = finishSegment(entry.draft, run.status);
    return segment ? [{ entryId: segment.segmentId, segment, type: "display_segment" }] : [];
  });
}
