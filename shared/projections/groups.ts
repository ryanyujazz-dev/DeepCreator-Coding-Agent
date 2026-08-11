import {
  Activity,
  Run,
  ActionKind,
  Changes
} from "../contracts/runtime";
import {
  ActivityGroup,
  DetailKind,
  DetailRow,
  LiveStep,
  TimelineEntry,
  ToolImportance
} from "./types";
import { isSkillActivity, toolImportance, toolTarget } from "./activityPresentation";

type MutableGroup = ActivityGroup & { members: Activity[] };

const IMPORTANCE_RANK: Record<ToolImportance, number> = {
  critical: 2,
  notable: 1,
  routine: 0
};

function maxImportance(left: ToolImportance, right: ToolImportance): ToolImportance {
  return IMPORTANCE_RANK[right] > IMPORTANCE_RANK[left] ? right : left;
}

function groupCategory(activity: Activity): ActionKind | undefined {
  const tool = activity.tool;
  if (!tool) return undefined;
  if (tool.action === "task" || tool.action === "plan") return undefined;
  if (tool.toolName === "run_command" && (tool.action === "execute" || tool.action === "verify")) return tool.action;
  if (tool.action === "inspect" || tool.action === "search") return "inspect";
  return tool.action;
}

function detailKind(activity: Activity): DetailKind {
  const tool = activity.tool!;
  if (tool.toolName === "read_file") return "read";
  if (tool.toolName === "list_files") return "list";
  if (tool.action === "search") return "search";
  if (tool.action === "modify") return "modify";
  if (tool.action === "verify") return "verify";
  if (tool.action === "task") return "task";
  if (tool.action === "plan") return "plan";
  if (tool.action === "external") return "external";
  return "execute";
}

function detailLabel(kind: DetailKind): string {
  return ({
    execute: "运行",
    external: "外部调用",
    list: "列出",
    modify: "修改",
    plan: "计划",
    read: "读取",
    search: "搜索",
    task: "任务",
    verify: "验证"
  } as const)[kind];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function changesForMembers(
  members: Activity[],
  changes: Changes
): Pick<Changes, "additions" | "deletions" | "fileCount"> {
  if (changes.comparisonBase !== "run_start") {
    return { additions: 0, deletions: 0, fileCount: 0 };
  }
  const targets = new Set(members.map((activity) => activity.tool?.normalizedTarget).filter(Boolean));
  const matching = changes.files.filter((file) => targets.has(file.path.replaceAll("\\", "/")));
  if (matching.length === 0) {
    return {
      additions: 0,
      deletions: 0,
      fileCount: 0
    };
  }
  return {
    additions: matching.reduce((sum, file) => sum + file.additions, 0),
    deletions: matching.reduce((sum, file) => sum + file.deletions, 0),
    fileCount: matching.length
  };
}

function summarize(group: MutableGroup, changes: Changes): string {
  const active = group.status === "running";
  const countUnit = group.category === "modify" ? "个文件" : group.category === "execute" ? "条" : "项";
  const failureSuffix = group.failureCount > 0 ? ` · ${group.failureCount} ${countUnit}失败` : "";
  const cancelledCount = group.members.filter((activity) => activity.status === "cancelled").length;
  const cancelledSuffix = cancelledCount > 0 ? ` · ${cancelledCount} ${countUnit}取消` : "";
  if (group.category === "modify") {
    const delta = changesForMembers(group.members, changes);
    group.changes = delta;
    const count = delta.fileCount || group.uniqueTargets.length || group.totalCalls;
    const prefix = active ? "正在修改" : "修改";
    const diff = delta.additions === 0 && delta.deletions === 0
      ? ""
      : ` +${delta.additions} -${delta.deletions}`;
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "文件修改失败";
    return `${prefix} ${count} 个文件${diff}${failureSuffix}${cancelledSuffix}`;
  }
  if (group.category === "verify") {
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "验证失败";
    return `${active ? "正在运行" : "运行"} ${group.totalCalls} 项验证${failureSuffix}${cancelledSuffix}`;
  }
  if (group.category === "execute") {
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "命令运行失败";
    return `${active ? "正在运行" : "运行"} ${group.totalCalls} 条命令${failureSuffix}${cancelledSuffix}`;
  }
  const fileCount = unique(
    group.members
      .filter((activity) => activity.tool?.targetKind === "file")
      .map((activity) => activity.tool?.normalizedTarget ?? "")
  ).length;
  if (fileCount > 0) return `${active ? "正在检查" : "检查"} ${fileCount} 个文件${failureSuffix}${cancelledSuffix}`;
  return `${active ? "正在检查" : "完成"} ${group.totalCalls} 项检查${failureSuffix}${cancelledSuffix}`;
}

function rebuildGroup(group: MutableGroup, changes: Changes): void {
  group.memberActivityIds = group.members.map((activity) => activity.activityId);
  group.totalCalls = group.members.length;
  group.successCount = group.members.filter((activity) => activity.status === "completed").length;
  group.failureCount = group.members.filter((activity) => activity.status === "failed").length;
  group.uniqueTargets = unique(group.members.map((activity) => toolTarget(activity.tool)));
  const currentActivity = [...group.members]
    .reverse()
    .find((activity) => activity.status === "running" && toolTarget(activity.tool));
  group.currentTarget = currentActivity ? toolTarget(currentActivity.tool) : undefined;
  group.status = group.members.some((activity) => activity.status === "running")
    ? "running"
    : group.failureCount > 0
      ? "failed"
      : group.members.some((activity) => activity.status === "cancelled")
        ? "cancelled"
        : "completed";
  group.finishedAt = group.status === "running"
    ? undefined
    : [...group.members].reverse().find((activity) => activity.finishedAt)?.finishedAt;
  group.importance = group.members.reduce(
    (importance, activity) => maxImportance(importance, toolImportance(activity.tool)),
    "routine" as ToolImportance
  );
  group.defaultExpanded = false;

  const rows = new Map<DetailKind, DetailRow>();
  for (const member of group.members) {
    const kind = detailKind(member);
    const existing = rows.get(kind) ?? {
      detailId: `${group.groupId}:${kind}`,
      kind,
      label: detailLabel(kind),
      targets: [],
      totalCalls: 0
    };
    existing.totalCalls += 1;
    existing.targets = unique([...existing.targets, toolTarget(member.tool)]);
    rows.set(kind, existing);
  }
  group.detailRows = [...rows.values()];
  group.summaryLabel = summarize(group, changes);
}

function createGroup(activity: Activity, category: ActionKind, changes: Changes): MutableGroup {
  const group: MutableGroup = {
    category,
    runId: activity.runId,
    defaultExpanded: false,
    detailRows: [],
    failureCount: 0,
    groupId: `activity_group:${activity.runId}:${activity.activityId}`,
    importance: toolImportance(activity.tool),
    memberActivityIds: [],
    members: [activity],
    status: activity.status,
    startedAt: activity.startedAt,
    successCount: 0,
    summaryLabel: "",
    totalCalls: 0,
    uniqueTargets: []
  };
  rebuildGroup(group, changes);
  return group;
}

function isInternallyHidden(activity: Activity): boolean {
  return activity.audience === "internal"
    || activity.tool?.action === "task"
    || (activity.tool?.action === "plan" && activity.kind !== "plan");
}

function isHiddenActivity(activity: Activity): boolean {
  return isInternallyHidden(activity)
    || (activity.kind === "thinking" && activity.status !== "running");
}

function stepIdFor(activity: Activity): string | undefined {
  return activity.modelStepId ?? activity.tool?.modelStepId;
}

function sameCategoryGroup(members: Activity[], changes: Changes): MutableGroup | undefined {
  const category = groupCategory(members[0]);
  if (!category) return undefined;
  const group = createGroup(members[0], category, changes);
  for (const member of members.slice(1)) group.members.push(member);
  rebuildGroup(group, changes);
  return group;
}

function summarizeMixedLiveTools(members: Activity[]): LiveStep {
  const running = members.some((activity) => activity.status === "running");
  const failedCount = members.filter((activity) => activity.status === "failed").length;
  const cancelledCount = members.filter((activity) => activity.status === "cancelled").length;
  const currentActivity = [...members]
    .reverse()
    .find((activity) => activity.status === "running" && toolTarget(activity.tool))
    ?? [...members].reverse().find((activity) => toolTarget(activity.tool));
  const currentTarget = currentActivity ? toolTarget(currentActivity.tool) : undefined;
  const fileCount = unique(
    members
      .filter((activity) => activity.tool?.targetKind === "file")
      .map((activity) => activity.tool?.normalizedTarget ?? "")
  ).length;
  const scope = fileCount > 0 ? `${fileCount} 个文件` : `${members.length} 项操作`;
  const prefix = running ? "正在处理" : failedCount > 0 ? "处理失败" : "完成";
  const failureSuffix = !running && failedCount > 0 ? ` · ${failedCount} 项失败` : "";
  const cancelledSuffix = !running && failedCount === 0 && cancelledCount > 0 ? ` · ${cancelledCount} 项取消` : "";
  return {
    category: "mixed",
    currentTarget,
    mode: "tools",
    status: running ? "running" : failedCount > 0 ? "failed" : cancelledCount > 0 ? "cancelled" : "completed",
    summaryLabel: `${prefix} ${scope}${failureSuffix}${cancelledSuffix}`,
    totalCalls: members.length
  };
}

function summarizeLiveTools(members: Activity[], changes: Changes): LiveStep {
  const categories = unique(members.map((activity) => groupCategory(activity) ?? ""));
  if (categories.length === 1) {
    const group = sameCategoryGroup(members, changes);
    if (group) {
      return {
        category: group.category,
        currentTarget: group.currentTarget ?? toolTarget([...members].reverse().find((activity) => toolTarget(activity.tool))?.tool),
        mode: "tools",
        status: group.status,
        summaryLabel: group.summaryLabel,
        totalCalls: group.totalCalls
      };
    }
  }
  return summarizeMixedLiveTools(members);
}

function projectLiveStep(
  run: Pick<Run, "runId" | "status" | "changes">,
  activities: Activity[]
): { hiddenActivityIds: Set<string>; liveStep: LiveStep } | undefined {
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return undefined;
  const tailSeed = [...activities]
    .reverse()
    .find((activity) => stepIdFor(activity) && !isInternallyHidden(activity));
  const tailStepId = tailSeed ? stepIdFor(tailSeed) : undefined;
  if (!tailStepId) return undefined;

  const tailActivities = activities.filter((activity) =>
    stepIdFor(activity) === tailStepId && !isInternallyHidden(activity)
  );
  if (tailActivities.length === 0) return undefined;
  if (tailActivities.some(isSkillActivity)) return undefined;

  const hiddenActivityIds = new Set(tailActivities.map((activity) => activity.activityId));
  const toolActivities = tailActivities.filter((activity) => Boolean(groupCategory(activity)));
  if (toolActivities.length > 0) {
    return { hiddenActivityIds, liveStep: summarizeLiveTools(toolActivities, run.changes) };
  }

  const message = [...tailActivities].reverse().find((activity) => activity.kind === "message");
  if (message) return { hiddenActivityIds, liveStep: { activity: message, mode: "message" } };

  const thinking = [...tailActivities].reverse().find((activity) => activity.kind === "thinking" && activity.status === "running");
  if (thinking) return { hiddenActivityIds, liveStep: { activity: thinking, mode: "thinking" } };

  return undefined;
}

export function projectGroups(
  run: Pick<Run, "runId" | "activities" | "changes" | "status">,
  activities = run.activities
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const liveStep = projectLiveStep(run, activities);
  let activeGroup: MutableGroup | undefined;

  for (const activity of activities) {
    if (liveStep?.hiddenActivityIds.has(activity.activityId)) continue;
    if (isHiddenActivity(activity)) continue;
    if (activity.kind === "thinking") {
      entries.push({ activity: activity, entryId: activity.activityId, type: "activity" });
      continue;
    }
    if (isSkillActivity(activity)) {
      activeGroup = undefined;
      entries.push({ activity, entryId: activity.activityId, type: "activity" });
      continue;
    }

    const category = groupCategory(activity);
    if (category) {
      if (!activeGroup || activeGroup.category !== category) {
        activeGroup = createGroup(activity, category, run.changes);
        entries.push({ entryId: activeGroup.groupId, group: activeGroup, type: "activity_group" });
      } else {
        activeGroup.members.push(activity);
        rebuildGroup(activeGroup, run.changes);
      }
      continue;
    }

    activeGroup = undefined;
    entries.push({ activity: activity, entryId: activity.activityId, type: "activity" });
  }
  if (liveStep) entries.push({ entryId: `live_step:${run.runId}`, liveStep: liveStep.liveStep, type: "live_step" });

  return entries.map((entry) => {
    if (entry.type !== "activity_group") return entry;
    const { members: _members, ...group } = entry.group as MutableGroup;
    return { ...entry, group };
  });
}
