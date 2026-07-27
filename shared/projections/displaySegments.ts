import {
  ActionKind,
  Activity,
  Run
} from "../contracts/runtime";
import {
  ActivityIndicator,
  ActivitySlot,
  DisplayTimelineEntry,
  DisplaySegment,
  ToolAggregate
} from "./types";
import { activityTitle, toolDisplayTarget, toolTarget } from "./activityPresentation";
import {
  dominantHeadlineKind,
  headlineKindForTool,
  headlineLabel,
  headlinePriority
} from "../domain/toolActivitySemantics";

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
  // Older failed Activity snapshots may have lost their ToolState when the
  // finishing event omitted it. Keep those tool facts inside the execution
  // aggregate instead of exposing raw errors as first-level timeline entries.
  if (!tool) return activity.kind === "tool" ? "inspect" : undefined;
  if (tool.action === "task" || tool.action === "plan") return undefined;
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
    transientBoundary: 0,
    transients: [],
    tools: []
  };
}

function toolStartLabel(activity: Activity): string {
  const target = toolDisplayTarget(activity.tool) || activityTitle(activity);
  let action = "正在执行";
  if (activity.tool?.toolName === "delegate" || activity.tool?.toolName === "spawn_agent") action = "委派";
  else if (activity.tool?.toolName === "read_file") action = "正在读取";
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
  const transitions: Transition[] = [];
  for (const transient of transients) {
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
  const activeTools = new Map<string, IndexedActivity>();
  let visual: ActivityIndicator | undefined;
  let logicalState: ActivitySlot["logicalState"] = "empty";
  let toolVisualSeen = false;

  const selectLastRunningTool = () => {
    const representative = [...activeTools.values()].sort((left, right) => {
      const callOrder = (left.activity.tool?.callIndex ?? left.index) - (right.activity.tool?.callIndex ?? right.index);
      return callOrder || left.index - right.index;
    }).at(-1);
    if (!representative) return false;
    visual = indicatorFor(representative.activity);
    logicalState = "active";
    toolVisualSeen = true;
    return true;
  };

  for (const transition of transitions) {
    if (transition.type === "start") {
      if (transition.activity.kind === "thinking") {
        if (!toolVisualSeen && activeTools.size === 0) {
          visual = indicatorFor(transition.activity);
          logicalState = "active";
        }
        continue;
      }
      activeTools.set(transition.activity.activityId, { activity: transition.activity, index: transition.index });
      selectLastRunningTool();
      continue;
    }
    if (transition.activity.kind === "thinking") {
      if (!toolVisualSeen && visual?.sourceActivityId === transition.activity.activityId) logicalState = "empty";
      continue;
    }
    activeTools.delete(transition.activity.activityId);
    if (!selectLastRunningTool()) {
      visual = indicatorFor(transition.activity);
      logicalState = "empty";
      toolVisualSeen = true;
    }
  }
  if (!visual) return [];
  return [{
    logicalState,
    slotId: `activity_slot:${transients[0].activity.activityId}`,
    visual
  }];
}

function aggregateBucket(activity: Activity): string {
  if (activity.tool?.toolName === "glob") return "match";
  if (activity.tool?.toolName === "grep") return "search_files";
  if (activity.tool?.toolName === "read_file") return "read";
  if (activity.tool?.toolName === "list_files") return "browse";
  if (activity.tool?.toolName === "web_search") return "external_search";
  if (activity.tool?.toolName === "fetch_url") return "external_read";
  if (activity.tool?.toolName === "git_status") return "review";
  if (activity.tool?.action === "modify") {
    const operations = new Set(activity.files?.map((file) => file.operation));
    if (operations.size === 1 && operations.has("created")) return "create";
    if (operations.size === 1 && operations.has("deleted")) return "delete";
    return "edit";
  }
  if (activity.tool?.action === "search") return "search";
  if (activity.tool?.action === "verify") return "verify";
  if (activity.tool?.toolName === "delegate" || activity.tool?.toolName === "spawn_agent") return "delegation";
  if (activity.tool?.toolName === "run_command" || activity.tool?.action === "execute") return "execute";
  if (activity.tool?.action === "external") return "external";
  return "inspect";
}

function uniqueObjectCount(activities: Activity[]): number {
  const measured = activities.reduce((count, activity) => count + (activity.tool?.resultMetrics?.itemCount ?? 0), 0);
  if (measured > 0) return measured;
  const targets = new Set(activities.map((activity) => activity.tool?.normalizedTarget).filter(Boolean));
  return targets.size || activities.length;
}

function bucketLabel(bucket: string, activities: Activity[], hasFailures: boolean): string {
  const count = uniqueObjectCount(activities);
  if (bucket === "browse") return `已浏览 ${count} 个目录`;
  if (bucket === "match") return `已匹配 ${count} 个文件`;
  if (bucket === "create") return `已创建 ${count} 个文件`;
  if (bucket === "edit") return `已编辑 ${count} 个文件`;
  if (bucket === "delete") return `已删除 ${count} 个文件`;
  if (bucket === "read") return `已读取 ${count} 个文件`;
  if (bucket === "search_files") return `已搜索 ${count} 个文件`;
  if (bucket === "search") return `已搜索 ${count} 项内容`;
  if (bucket === "external_search") return `已检索 ${count} 项外部结果`;
  if (bucket === "external_read") return `已查阅 ${count} 个页面`;
  if (bucket === "review") return `已检查 ${count} 次工作区改动`;
  if (bucket === "delegation") return `已委派 ${activities.length} 个子代理`;
  if (bucket === "verify") return `已完成 ${count} 项验证`;
  if (bucket === "execute") return hasFailures
    ? `成功运行 ${activities.length} 条命令`
    : `已运行 ${activities.length} 条命令`;
  if (bucket === "external") return `已完成 ${activities.length} 项外部调用`;
  return `已检查 ${count} 项`;
}

function projectAggregate(draft: SegmentDraft): ToolAggregate | undefined {
  const settled = draft.tools.filter((activity) => activity.status !== "running");
  if (settled.length === 0) return undefined;
  const hasRunning = draft.tools.some((activity) => activity.status === "running");
  const buckets = new Map<string, Activity[]>();
  for (const activity of settled.filter((item) => item.status === "completed")) {
    const bucket = aggregateBucket(activity);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), activity]);
  }
  const delegationOnly = settled.length > 0 && settled.every((activity) => Boolean(activity.delegation));
  const failureCount = delegationOnly
    ? settled.filter((activity) => activity.delegation?.status === "failed").length
    : settled.filter((activity) => activity.status === "failed").length;
  const cancelledCount = delegationOnly
    ? settled.filter((activity) => activity.delegation?.status === "cancelled").length
    : settled.filter((activity) => activity.status === "cancelled").length;
  const suffix = [
    failureCount > 0 ? `${failureCount} 项失败` : "",
    cancelledCount > 0 ? `${cancelledCount} 项已取消` : ""
  ].filter(Boolean).join(" · ");
  const delegationActive = delegationOnly && settled.some((activity) =>
    activity.delegation?.status === "running" || activity.delegation?.status === "waiting"
  );
  const status = hasRunning || delegationActive
    ? "running"
    : failureCount > 0 ? "failed" : cancelledCount > 0 ? "cancelled" : "completed";
  const summary = [...buckets].map(([bucket, activities]) => bucketLabel(bucket, activities, failureCount > 0)).join(" · ");
  const headlineKind = draft.tools.reduce<ReturnType<typeof headlineKindForTool> | undefined>((dominant, activity) => {
    const candidate = activity.tool
      ? activity.tool.stepHeadline ?? headlineKindForTool(activity.tool)
      : undefined;
    if (!candidate) return dominant;
    if (!dominant || headlinePriority(candidate) > headlinePriority(dominant)) return candidate;
    return dominant;
  }, dominantHeadlineKind(draft.tools.flatMap((activity) => activity.tool ? [activity.tool] : [])));
  const resolvedHeadline = headlineKind ?? (draft.tools.some((activity) => activity.tool?.toolName === "run_command") ? "execute" : "read");
  return {
    aggregateId: `tool_aggregate:${draft.segmentId}`,
    cancelledCount,
    failureCount,
    headlineKind: resolvedHeadline,
    headlineLabel: headlineLabel(resolvedHeadline),
    memberActivityIds: settled.map((activity) => activity.activityId),
    runId: draft.runId,
    semantic: delegationOnly ? "delegation" : undefined,
    status,
    successCount: delegationOnly
      ? settled.filter((activity) => activity.delegation?.status === "completed").length
      : settled.filter((activity) => activity.status === "completed").length,
    summaryLabel: [summary, suffix].filter(Boolean).join(" · "),
    totalCalls: settled.length
  };
}

function finishSegment(draft: SegmentDraft): DisplaySegment | undefined {
  const activitySlots = projectActivitySlots(draft.transients.slice(draft.transientBoundary));
  const aggregate = projectAggregate(draft);
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
  run: Pick<Run, "runId" | "activities">,
  activities = run.activities,
  options: DisplayProjectionOptions = {}
): DisplayTimelineEntry[] {
  const entries: DraftEntry[] = [];
  let current: SegmentDraft | undefined;

  const ensureSegment = (activity: Activity) => {
    if (current) return current;
    current = createDraft(activity);
    entries.push({ draft: current, type: "display_segment" });
    return current;
  };

  for (const [index, activity] of activities.entries()) {
    if (isInternal(activity)) continue;
    if (activity.kind === "user_message") {
      entries.push({ activity, type: "activity" });
      current = undefined;
      continue;
    }
    if (activity.kind === "message") {
      if (current && (current.contentSeen || current.tools.length > 0)) {
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
      ensureSegment(activity).transients.push({ activity, index });
      continue;
    }
    if (toolCategory(activity)) {
      const segment = ensureSegment(activity);
      segment.tools.push(activity);
      segment.transients.push({ activity, index });
      continue;
    }
    entries.push({ activity, type: "activity" });
  }

  return entries.flatMap<DisplayTimelineEntry>((entry) => {
    if (entry.type === "activity") {
      return [{ activity: entry.activity, entryId: entry.activity.activityId, type: "activity" }];
    }
    const segment = finishSegment(entry.draft);
    return segment ? [{ entryId: segment.segmentId, segment, type: "display_segment" }] : [];
  });
}
