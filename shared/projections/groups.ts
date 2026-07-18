import {
  Activity,
  Run,
  DetailKind,
  DetailRow,
  ActivityGroup,
  TimelineEntry,
  ToolImportance,
  ActionKind,
  Changes
} from "../contracts/runtime";

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
  if (tool.action === "plan") return undefined;
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
  const cancelledSuffix = cancelledCount > 0 ? ` · ${cancelledCount} ${countUnit}已取消` : "";
  if (group.category === "modify") {
    const delta = changesForMembers(group.members, changes);
    group.changes = delta;
    const count = delta.fileCount || group.uniqueTargets.length || group.totalCalls;
    const prefix = active ? "正在修改" : "已修改";
    const diff = active || (delta.additions === 0 && delta.deletions === 0)
      ? ""
      : ` +${delta.additions} -${delta.deletions}`;
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "文件修改失败";
    return `${prefix} ${count} 个文件${diff}${failureSuffix}${cancelledSuffix}`;
  }
  if (group.category === "verify") {
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "验证失败";
    return `${active ? "正在运行" : "已运行"} ${group.totalCalls} 项验证${failureSuffix}${cancelledSuffix}`;
  }
  if (group.category === "execute") {
    if (!active && group.totalCalls === 1 && group.failureCount === 1) return "命令运行失败";
    return `${active ? "正在运行" : "已运行"} ${group.totalCalls} 条命令${failureSuffix}${cancelledSuffix}`;
  }
  const fileCount = unique(
    group.members
      .filter((activity) => activity.tool?.targetKind === "file")
      .map((activity) => activity.tool?.normalizedTarget ?? "")
  ).length;
  if (fileCount > 0) return `${active ? "正在检查" : "已检查"} ${fileCount} 个文件${failureSuffix}${cancelledSuffix}`;
  return `${active ? "正在检查" : "已完成"} ${group.totalCalls} 项检查${failureSuffix}${cancelledSuffix}`;
}

function rebuildGroup(group: MutableGroup, changes: Changes): void {
  group.memberActivityIds = group.members.map((activity) => activity.activityId);
  group.totalCalls = group.members.length;
  group.successCount = group.members.filter((activity) => activity.status === "completed").length;
  group.failureCount = group.members.filter((activity) => activity.status === "failed").length;
  group.uniqueTargets = unique(group.members.map((activity) => activity.tool?.displayTarget ?? ""));
  group.currentTarget = [...group.members]
    .reverse()
    .find((activity) => activity.status === "running" && activity.tool?.displayTarget)
    ?.tool?.displayTarget;
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
    (importance, activity) => maxImportance(importance, activity.tool?.importance ?? "routine"),
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
    existing.targets = unique([...existing.targets, member.tool?.displayTarget ?? ""]);
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
    importance: activity.tool?.importance ?? "routine",
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

function isHiddenActivity(activity: Activity): boolean {
  return activity.audience === "internal"
    || activity.tool?.action === "plan"
    || (activity.kind === "thinking" && activity.status !== "running");
}

export function projectGroups(
  run: Pick<Run, "runId" | "activities" | "changes">,
  activities = run.activities
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let activeGroup: MutableGroup | undefined;

  for (const activity of activities) {
    if (isHiddenActivity(activity)) continue;
    if (activity.kind === "thinking") {
      entries.push({ activity: activity, entryId: activity.activityId, type: "activity" });
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

  return entries.map((entry) => {
    if (entry.type !== "activity_group") return entry;
    const { members: _members, ...group } = entry.group as MutableGroup;
    return { ...entry, group };
  });
}
