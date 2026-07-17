import {
  ActivityUnitView,
  CycleView,
  OperationDetailKind,
  OperationDetailRow,
  OperationGroupView,
  TimelineProjectionEntry,
  ToolImportance,
  ToolOperationClass,
  WorkspaceDeltaView
} from "./runtimeTypes";

type MutableGroup = OperationGroupView & { members: ActivityUnitView[] };

const IMPORTANCE_RANK: Record<ToolImportance, number> = {
  critical: 2,
  notable: 1,
  routine: 0
};

function maxImportance(left: ToolImportance, right: ToolImportance): ToolImportance {
  return IMPORTANCE_RANK[right] > IMPORTANCE_RANK[left] ? right : left;
}

function groupCategory(unit: ActivityUnitView): ToolOperationClass | undefined {
  const tool = unit.tool;
  if (!tool || unit.phase === "failed" || unit.phase === "cancelled") return undefined;
  if (tool.toolName === "run_command" && (tool.operationClass === "execute" || tool.operationClass === "verify")) return tool.operationClass;
  if (tool.aggregationPolicy === "standalone") return undefined;
  if (tool.operationClass === "inspect" || tool.operationClass === "search") return "inspect";
  if (tool.operationClass === "modify" && tool.aggregationPolicy === "workspace_delta") return "modify";
  if (tool.operationClass === "verify" && tool.aggregationPolicy === "consecutive") return "verify";
  return undefined;
}

function detailKind(unit: ActivityUnitView): OperationDetailKind {
  const tool = unit.tool!;
  if (tool.toolName === "read_file") return "read";
  if (tool.toolName === "list_files") return "list";
  if (tool.operationClass === "search") return "search";
  if (tool.operationClass === "modify") return "modify";
  if (tool.operationClass === "verify") return "verify";
  if (tool.operationClass === "plan") return "plan";
  if (tool.operationClass === "external") return "external";
  return "execute";
}

function detailLabel(kind: OperationDetailKind): string {
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

function workspaceDeltaForMembers(
  members: ActivityUnitView[],
  workspaceDelta: WorkspaceDeltaView
): Pick<WorkspaceDeltaView, "additions" | "deletions" | "fileCount"> {
  if (workspaceDelta.comparisonBase !== "cycle_start") {
    return { additions: 0, deletions: 0, fileCount: 0 };
  }
  const targets = new Set(members.map((unit) => unit.tool?.normalizedTarget).filter(Boolean));
  const matching = workspaceDelta.files.filter((file) => targets.has(file.path.replaceAll("\\", "/")));
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

function summarize(group: MutableGroup, workspaceDelta: WorkspaceDeltaView): string {
  const active = group.phase === "open";
  if (group.category === "modify") {
    const delta = workspaceDeltaForMembers(group.members, workspaceDelta);
    group.workspaceDelta = delta;
    const count = delta.fileCount || group.uniqueTargets.length || group.totalCalls;
    const prefix = active ? "正在修改" : "已修改";
    const diff = active || (delta.additions === 0 && delta.deletions === 0)
      ? ""
      : ` +${delta.additions} -${delta.deletions}`;
    return `${prefix} ${count} 个文件${diff}`;
  }
  if (group.category === "verify") {
    return `${active ? "正在运行" : "已运行"} ${group.totalCalls} 项验证`;
  }
  if (group.category === "execute") {
    return `${active ? "正在运行" : "已运行"} ${group.totalCalls} 条命令`;
  }
  const fileCount = unique(
    group.members
      .filter((unit) => unit.tool?.resourceKind === "file")
      .map((unit) => unit.tool?.normalizedTarget ?? "")
  ).length;
  if (fileCount > 0) return `${active ? "正在检查" : "已检查"} ${fileCount} 个文件`;
  return `${active ? "正在检查" : "已完成"} ${group.totalCalls} 项检查`;
}

function rebuildGroup(group: MutableGroup, workspaceDelta: WorkspaceDeltaView): void {
  group.memberUnitKeys = group.members.map((unit) => unit.unitKey);
  group.totalCalls = group.members.length;
  group.successCount = group.members.filter((unit) => unit.phase === "succeeded").length;
  group.failureCount = group.members.filter((unit) => unit.phase === "failed").length;
  group.uniqueTargets = unique(group.members.map((unit) => unit.tool?.displayTarget ?? ""));
  group.currentTarget = [...group.members]
    .reverse()
    .find((unit) => unit.phase === "open" && unit.tool?.displayTarget)
    ?.tool?.displayTarget;
  group.phase = group.members.some((unit) => unit.phase === "open")
    ? "open"
    : group.failureCount > 0
      ? "failed"
      : group.members.some((unit) => unit.phase === "cancelled")
        ? "cancelled"
        : "succeeded";
  group.sealedAt = group.phase === "open"
    ? undefined
    : [...group.members].reverse().find((unit) => unit.sealedAt)?.sealedAt;
  group.importance = group.members.reduce(
    (importance, unit) => maxImportance(importance, unit.tool?.importance ?? "routine"),
    "routine" as ToolImportance
  );
  group.defaultExpanded = false;

  const rows = new Map<OperationDetailKind, OperationDetailRow>();
  for (const member of group.members) {
    const kind = detailKind(member);
    const existing = rows.get(kind) ?? {
      detailKey: `${group.groupKey}:${kind}`,
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
  group.summaryLabel = summarize(group, workspaceDelta);
}

function createGroup(unit: ActivityUnitView, category: ToolOperationClass, workspaceDelta: WorkspaceDeltaView): MutableGroup {
  const group: MutableGroup = {
    category,
    cycleKey: unit.cycleKey,
    defaultExpanded: false,
    detailRows: [],
    failureCount: 0,
    groupKey: `operation_group:${unit.cycleKey}:${unit.unitKey}`,
    importance: unit.tool?.importance ?? "routine",
    memberUnitKeys: [],
    members: [unit],
    phase: unit.phase,
    startedAt: unit.openedAt,
    successCount: 0,
    summaryLabel: "",
    totalCalls: 0,
    uniqueTargets: []
  };
  rebuildGroup(group, workspaceDelta);
  return group;
}

function isInvisibleCompletedUnit(unit: ActivityUnitView): boolean {
  return unit.audience === "internal" || (unit.kind === "thinking" && unit.phase !== "open");
}

export function projectOperationGroups(
  cycle: Pick<CycleView, "cycleKey" | "units" | "workspaceDelta">,
  units = cycle.units
): TimelineProjectionEntry[] {
  const entries: TimelineProjectionEntry[] = [];
  let activeGroup: MutableGroup | undefined;

  for (const unit of units) {
    if (isInvisibleCompletedUnit(unit)) continue;
    if (unit.kind === "thinking") {
      entries.push({ entryKey: unit.unitKey, type: "activity_unit", unit });
      continue;
    }

    const category = groupCategory(unit);
    if (category) {
      if (!activeGroup || activeGroup.category !== category) {
        activeGroup = createGroup(unit, category, cycle.workspaceDelta);
        entries.push({ entryKey: activeGroup.groupKey, group: activeGroup, type: "operation_group" });
      } else {
        activeGroup.members.push(unit);
        rebuildGroup(activeGroup, cycle.workspaceDelta);
      }
      continue;
    }

    activeGroup = undefined;
    entries.push({ entryKey: unit.unitKey, type: "activity_unit", unit });
  }

  return entries.map((entry) => {
    if (entry.type !== "operation_group") return entry;
    const { members: _members, ...group } = entry.group as MutableGroup;
    return { ...entry, group };
  });
}
