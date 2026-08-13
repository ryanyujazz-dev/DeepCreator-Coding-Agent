import assert from "node:assert/strict";
import test from "node:test";
import { projectDisplayTimeline } from "../shared/projections/displaySegments";
import { fileDisplayName } from "../shared/projections/activityPresentation";
import { Activity, Run, ToolState, emptyChanges } from "../shared/contracts/runtime";

test("uses only the file name for visible file targets", () => {
  assert.equal(fileDisplayName("src/components/App.tsx"), "App.tsx");
  assert.equal(fileDisplayName("src\\components\\styles.css"), "styles.css");
  assert.equal(fileDisplayName(".env"), ".env");
});

function tool(overrides: Partial<ToolState> = {}): ToolState {
  return {
    action: "inspect",
    argumentsPreview: "{}",
    callId: "call_1",
    detail: { defaultCollapsed: true, pathStyle: "workspace_relative", previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effect: "read_only",
    groupMode: "consecutive",
    importance: "routine",
    modelStepId: "step_1",
    normalizedTarget: "src/App.tsx",
    targetKind: "file",
    toolName: "read_file",
    ...overrides
  };
}

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: `activity_${index}`,
    audience: "user",
    body: "",
    finishedAt: `2026-07-20T10:00:${String(index).padStart(2, "0")}.500Z`,
    kind: "tool",
    runId: "run_display",
    startedAt: `2026-07-20T10:00:${String(index).padStart(2, "0")}.000Z`,
    status: "completed",
    title: "读取文件",
    tool: tool({ callId: `call_${index}` }),
    ...overrides
  };
}

function skillActivity(
  index: number,
  toolName: "install_skill" | "invoke_capability" | "materialize_skill_asset" | "preview_skill_install" | "read_skill_resource" | "run_skill_script" | "search_capabilities",
  overrides: Partial<Activity> = {}
): Activity {
  const target = toolName === "search_capabilities" ? "发布 Electron" : "skill:release-electron";
  return activity(index, {
    body: `result for ${toolName}`,
    kind: toolName === "run_skill_script" ? "command" : "tool",
    title: "Skill 活动",
    tool: tool({
      action: toolName === "run_skill_script" ? "execute" : "inspect",
      callId: `call_skill_${index}`,
      displayTarget: target,
      effect: toolName === "run_skill_script" ? "process_side_effect" : "read_only",
      normalizedTarget: target,
      targetKind: toolName === "run_skill_script" ? "process" : "workspace",
      toolName
    }),
    ...overrides
  });
}

function thinking(index: number, status: Activity["status"] = "running"): Activity {
  return activity(index, {
    audience: "debug",
    finishedAt: status === "running" || status === "suspended"
      ? undefined
      : `2026-07-20T10:00:${String(index).padStart(2, "0")}.500Z`,
    kind: "thinking",
    modelStepId: `step_${index}`,
    status,
    tool: undefined
  });
}

function message(index: number, body: string): Activity {
  return activity(index, { body, kind: "message", status: "running", finishedAt: undefined, tool: undefined });
}

function run(activities: Activity[]): Run {
  return {
    activities,
    answer: "",
    approvals: [],
    changes: emptyChanges(),
    lastOffset: activities.length,
    mode: "work",
    model: "test",
    prompt: "test",
    runId: "run_display",
    sessionId: "session_display",
    startedAt: "2026-07-20T10:00:00.000Z",
    status: "running",
    tasks: []
  };
}

function onlySegment(input: Run) {
  const entries = projectDisplayTimeline(input);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") throw new Error("Expected a display segment");
  return entries[0].segment;
}

test("replaces thinking with content inside the same stable segment", () => {
  const before = onlySegment(run([thinking(1)]));
  const after = onlySegment(run([thinking(1, "completed"), message(2, "我先检查一下配置文件。")]));
  assert.equal(before.segmentId, after.segmentId);
  assert.equal(before.mainActivity, undefined);
  assert.equal(before.activitySlots[0]?.visual.label, "正在思考");
  assert.equal(after.mainActivity?.body, "我先检查一下配置文件。");
  assert.deepEqual(after.activitySlots, []);
});

test("keeps later thinking in the activity slot after content exists", () => {
  const segment = onlySegment(run([message(1, "我先检查一下配置文件。"), thinking(2)]));
  assert.equal(segment.mainActivity?.activityId, "activity_1");
  assert.equal(segment.activitySlots[0]?.logicalState, "active");
  assert.equal(segment.activitySlots[0]?.visual.label, "正在思考");
});

test("keeps an in-run user steer as a standalone timeline entry", () => {
  const steer = activity(3, {
    body: "停止修改配置，先检查测试。",
    kind: "user_message",
    tool: undefined
  });
  const entries = projectDisplayTimeline(run([message(1, "开始处理。"), activity(2), steer, thinking(4)]));
  assert.equal(entries.length, 3);
  assert.equal(entries[1].type, "activity");
  if (entries[1].type !== "activity") return;
  assert.equal(entries[1].activity.kind, "user_message");
  assert.equal(entries[1].activity.body, "停止修改配置，先检查测试。");
});

test("keeps ask_user as a standalone expandable execution fact", () => {
  const askUser = activity(2, {
    body: "等待用户回答方案问题。",
    title: "询问方案问题",
    tool: tool({
      action: "plan",
      callId: "call_question",
      displayTarget: "方案问题",
      effect: "control_only",
      normalizedTarget: "方案问题",
      targetKind: "plan",
      toolName: "ask_user"
    })
  });
  const entries = projectDisplayTimeline(run([message(1, "我需要确认一个选择。"), askUser, thinking(3)]));
  assert.equal(entries.length, 3);
  assert.equal(entries[1].type, "activity");
  if (entries[1].type !== "activity") return;
  assert.equal(entries[1].activity.tool?.toolName, "ask_user");
});

test("holds suspended thinking visually without treating it as terminal", () => {
  const held = onlySegment(run([thinking(1, "suspended")]));
  assert.equal(held.activitySlots[0]?.logicalState, "empty");
  assert.equal(held.activitySlots[0]?.visual.label, "正在思考");

  const runningRead = activity(2, { finishedAt: undefined, status: "running" });
  const active = onlySegment(run([thinking(1, "suspended"), runningRead]));
  assert.equal(active.activitySlots[0]?.logicalState, "active");
  assert.equal(active.activitySlots[0]?.visual.label, "正在读取 App.tsx");
});

test("aggregate materializes only when content closes a ≥2-tool span", () => {
  const content = message(1, "我先检查一下配置文件。");
  const firstRead = activity(2);
  const secondRead = activity(3, {
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  });

  // While the span is LIVE (no closing content yet), even with ≥2 done tools
  // there is NO aggregate — the activity slot just tracks the latest tool.
  const live = onlySegment(run([content, firstRead, secondRead]));
  assert.equal(live.aggregate, undefined);
  assert.equal(live.activitySlots[0]?.logicalState, "empty");
  assert.equal(live.activitySlots[0]?.visual.label, "正在读取 .env");

  // A closing content message materializes the aggregate; it replaces the slot.
  const closed = projectDisplayTimeline(run([content, firstRead, secondRead, message(4, "处理完成。")]));
  const prior = closed[0];
  assert.equal(prior.type === "display_segment" && prior.segment.aggregate?.summaryLabel, "读取 2 个文件");
  assert.equal(prior.type === "display_segment" && prior.segment.aggregate?.status, "completed");
  assert.equal(prior.type === "display_segment" && prior.segment.activitySlots.length, 0);
});

test("a single-tool closed span lingers as a hollow-ring slot, not an aggregate", () => {
  const content = message(1, "我先检查一下配置文件。");
  const completedRead = activity(2);
  // Closing content arrives but the span held only ONE tool → no aggregate; the
  // lone tool's done state stays as the span's final representation.
  const closed = projectDisplayTimeline(run([content, completedRead, message(3, "处理完成。")]));
  const prior = closed[0];
  assert.equal(prior.type === "display_segment" && prior.segment.aggregate, undefined);
  assert.equal(prior.type === "display_segment" && prior.segment.activitySlots[0]?.logicalState, "empty");
  assert.equal(prior.type === "display_segment" && prior.segment.activitySlots[0]?.visual.label, "正在读取 App.tsx");
});

test("holds an empty activity slot until the next transient state takes over", () => {
  const content = message(1, "我先检查一下配置文件。");
  const completedRead = activity(2);
  const held = onlySegment(run([content, completedRead]));
  const nextRead = activity(3, {
    finishedAt: undefined,
    status: "running",
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  });
  const active = onlySegment(run([content, completedRead, nextRead]));
  assert.equal(held.activitySlots[0]?.logicalState, "empty");
  assert.equal(active.activitySlots[0]?.logicalState, "active");
  assert.equal(active.activitySlots[0]?.visual.label, "正在读取 .env");
});

test("aggregates mixed completed tools under one header in a segment", () => {
  const edit = activity(3, {
    kind: "file_mutation",
    title: "编辑文件",
    tool: tool({
      action: "modify",
      callId: "call_3",
      displayTarget: "src/main.ts",
      effect: "workspace_write",
      normalizedTarget: "src/main.ts",
      toolName: "edit_file"
    })
  });
  const entries = projectDisplayTimeline(run([
    message(1, "开始处理。"),
    activity(2),
    edit,
    message(4, "处理完成。")
  ]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "读取 1 个文件 · 编辑 1 个文件");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2", "activity_3"]);
});

test("aggregate expands to include a still-running tool while counting only settled ones", () => {
  const completedRead = activity(2);
  const completedSecond = activity(3, {
    tool: tool({ callId: "call_3", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" })
  });
  const runningEdit = activity(4, {
    finishedAt: undefined,
    status: "running",
    tool: tool({
      action: "modify",
      callId: "call_4",
      displayTarget: "src/main.ts",
      effect: "workspace_write",
      normalizedTarget: "src/main.ts",
      toolName: "edit_file"
    })
  });
  const entries = projectDisplayTimeline(run([
    message(1, "开始处理。"),
    completedRead,
    completedSecond,
    runningEdit,
    message(5, "处理完成。")
  ]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  // Closing content sealed a span holding 2 done + 1 running tool. The aggregate
  // materializes (3 calls ≥2), reads as running (a member is still going), and
  // REPLACES the activity slot.
  assert.equal(segment.aggregate?.status, "running");
  // The summary counts only settled tools (the running edit is NOT counted).
  assert.equal(segment.aggregate?.summaryLabel, "读取 2 个文件");
  assert.equal(segment.aggregate?.totalCalls, 3);
  // The expanded member list includes the running tool so it can be seen
  // (with sweep) inside the expanded aggregate.
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2", "activity_3", "activity_4"]);
  // The aggregate replaced the activity slot (no live slot alongside).
  assert.equal(segment.activitySlots.length, 0);
});

test("renders every Skill tool as a standalone first-level segment", () => {
  const toolNames = [
    "search_capabilities",
    "invoke_capability",
    "preview_skill_install",
    "install_skill",
    "read_skill_resource",
    "materialize_skill_asset",
    "run_skill_script"
  ] as const;

  for (const [offset, toolName] of toolNames.entries()) {
    const segment = onlySegment(run([skillActivity(offset + 1, toolName)]));
    assert.equal(segment.aggregate, undefined, toolName);
    assert.equal(segment.mainActivity, undefined, toolName);
    assert.equal(segment.activitySlots.length, 1, toolName);
    assert.equal(segment.activitySlots[0].visual.sourceActivityId, `activity_${offset + 1}`, toolName);
    assert.match(segment.activitySlots[0].visual.label, /Skill/, toolName);
  }
});

test("uses a standalone Skill segment to split aggregate headers on both sides", () => {
  const entries = projectDisplayTimeline(run([
    message(1, "先检查仓库。"),
    activity(2),
    activity(5, {
      tool: tool({
        callId: "call_5",
        displayTarget: "src/other.ts",
        normalizedTarget: "src/other.ts"
      })
    }),
    skillActivity(3, "invoke_capability"),
    activity(4, {
      tool: tool({
        callId: "call_4",
        displayTarget: "src/main.ts",
        normalizedTarget: "src/main.ts"
      })
    }),
    activity(6, {
      tool: tool({
        callId: "call_6",
        displayTarget: "src/next.ts",
        normalizedTarget: "src/next.ts"
      })
    })
  ]));

  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.type === "display_segment"));
  if (entries.some((entry) => entry.type !== "display_segment")) return;
  const [before, skill, after] = entries.map((entry) => entry.segment);
  // `before` span (activity_2, activity_5) is closed by the Skill → aggregate.
  assert.deepEqual(before.aggregate?.memberActivityIds, ["activity_2", "activity_5"]);
  assert.deepEqual(before.activitySlots, []);
  assert.equal(skill.aggregate, undefined);
  assert.equal(skill.activitySlots[0]?.visual.label, "加载 Skill · skill:release-electron");
  // `after` span (activity_4, activity_6) is still LIVE (no closing content) →
  // no aggregate; the latest tool shows as a lingering activity slot.
  assert.equal(after.aggregate, undefined);
  assert.equal(after.activitySlots[0]?.visual.label, "正在读取 next.ts");
});

test("keeps a running Skill script in its own active slot with its command identity", () => {
  const script = skillActivity(3, "run_skill_script", {
    body: "building package...",
    command: {
      command: "node validate-skill.mjs",
      commandId: "command_skill_1",
      state: "running"
    },
    finishedAt: undefined,
    status: "running"
  });
  const firstTool = activity(1);
  const secondTool = activity(2, {
    tool: tool({ callId: "call_2", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" })
  });
  const entries = projectDisplayTimeline(run([firstTool, secondTool, script]));

  assert.equal(entries.length, 2);
  assert.equal(entries[1].type, "display_segment");
  if (entries[1].type !== "display_segment") return;
  assert.equal(entries[1].segment.aggregate, undefined);
  assert.equal(entries[1].segment.activitySlots[0]?.logicalState, "active");
  assert.equal(entries[1].segment.activitySlots[0]?.visual.label, "正在运行 Skill 脚本 · skill:release-electron");
  assert.equal(script.command?.commandId, "command_skill_1");
});

test("shows Skill installation as waiting while hash trust is unresolved", () => {
  const segment = onlySegment(run([skillActivity(1, "install_skill", {
    finishedAt: undefined,
    status: "suspended"
  })]));
  assert.equal(segment.aggregate, undefined);
  assert.equal(segment.activitySlots[0]?.logicalState, "empty");
  assert.equal(segment.activitySlots[0]?.visual.label, "等待确认安装 Skill · skill:release-electron");
});

test("does not leave a thinking-only row before a standalone Skill segment", () => {
  const entries = projectDisplayTimeline(run([
    thinking(1, "completed"),
    skillActivity(2, "search_capabilities")
  ]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  assert.equal(entries[0].segment.activitySlots[0]?.visual.label, "搜索 Skill · 发布 Electron");
});

test("uses the sealed step headline before every tool in that step has started", () => {
  const entries = projectDisplayTimeline(run([
    message(1, "开始处理。"),
    activity(2, { tool: tool({ stepHeadline: "modify" }) }),
    activity(3, { tool: tool({ callId: "call_3", stepHeadline: "modify", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" }) }),
    message(4, "处理完成。")
  ]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "读取 2 个文件");
});

test("counts only successful objects and reports failed attempts separately", () => {
  const failedEdit = activity(3, {
    error: "oldText 不唯一",
    kind: "file_mutation",
    status: "failed",
    tool: tool({
      action: "modify",
      callId: "call_failed_edit",
      effect: "workspace_write",
      normalizedTarget: "src/main.ts",
      toolName: "edit_file"
    })
  });
  const entries = projectDisplayTimeline(run([message(1, "开始处理。"), activity(2), failedEdit, message(4, "处理完成。")]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "读取 1 个文件 · 1 项失败");
  assert.equal(segment.aggregate?.successCount, 1);
  assert.equal(segment.aggregate?.failureCount, 1);
});

test("keeps command success and failure facts unambiguous under a semantic headline", () => {
  const commandTool = (callId: string): ToolState => tool({
    action: "execute",
    callId,
    effect: "process_side_effect",
    normalizedTarget: "docker compose up -d postgres",
    stepHeadline: "start_database",
    targetKind: "process",
    toolName: "run_command"
  });
  const successful = activity(2, { kind: "command", tool: commandTool("call_command_success") });
  const failed = activity(3, {
    error: "container name conflict",
    kind: "command",
    status: "failed",
    tool: commandTool("call_command_failure")
  });
  const entries = projectDisplayTimeline(run([message(1, "启动数据库。"), successful, failed, message(4, "处理完成。")]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.headlineLabel, "启动数据库");
  assert.equal(segment.aggregate?.summaryLabel, "成功运行 1 条命令 · 1 项失败");
});

test("keeps legacy failed tools without ToolState inside the aggregate", () => {
  const legacyFailure = activity(2, {
    body: "ENOTDIR: not a directory",
    error: "ENOTDIR: not a directory",
    status: "failed",
    tool: undefined
  });
  const entries = projectDisplayTimeline(run([message(1, "继续检查。"), activity(3), legacyFailure, message(4, "处理完成。")]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.failureCount, 1);
  assert.equal(segment.aggregate?.status, "failed");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_3", "activity_2"]);
});

test("starts a new segment only when the next content arrives", () => {
  const firstContent = message(1, "第一段。");
  const firstTool = activity(2);
  const firstExtra = activity(6, {
    tool: tool({ callId: "call_6", displayTarget: "src/extra.ts", normalizedTarget: "src/extra.ts" })
  });
  const nextThinking = thinking(3, "completed");
  const beforeContent = projectDisplayTimeline(run([firstContent, firstTool, firstExtra, nextThinking]));
  assert.equal(beforeContent.length, 1);
  assert.equal(beforeContent[0].type === "display_segment" && beforeContent[0].segment.activitySlots[0]?.visual.label, "正在读取 extra.ts");

  const entries = projectDisplayTimeline(run([
    firstContent,
    firstTool,
    firstExtra,
    nextThinking,
    message(4, "第二段。"),
    activity(5, {
      tool: tool({ callId: "call_5", displayTarget: "src/next.ts", normalizedTarget: "src/next.ts" })
    }),
    activity(7, {
      tool: tool({ callId: "call_7", displayTarget: "src/next2.ts", normalizedTarget: "src/next2.ts" })
    })
  ]));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.type === "display_segment"));
  if (entries[0].type !== "display_segment" || entries[1].type !== "display_segment") return;
  // seg0 was closed by message(4) → its 2-tool span materializes as an aggregate.
  assert.deepEqual(entries[0].segment.aggregate?.memberActivityIds, ["activity_2", "activity_6"]);
  assert.deepEqual(entries[0].segment.activitySlots, []);
  // seg1 is still LIVE (no closing content after activity_5/activity_7) → no
  // aggregate; the latest tool shows as a lingering activity slot.
  assert.equal(entries[1].segment.aggregate, undefined);
  assert.equal(entries[1].segment.activitySlots[0]?.visual.label, "正在读取 next2.ts");
  assert.equal(entries[1].segment.mainActivity?.body, "第二段。");
});

test("supports a tool-only segment while preserving the held start label", () => {
  const segment = onlySegment(run([
    thinking(1, "completed"),
    activity(2),
    activity(3, { tool: tool({ callId: "call_3", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" }) })
  ]));
  assert.equal(segment.mainActivity, undefined);
  // Live tail span (no closing content) → no aggregate; the latest tool's done
  // state lingers as the activity slot.
  assert.equal(segment.aggregate, undefined);
  assert.equal(segment.activitySlots[0]?.logicalState, "empty");
  assert.equal(segment.activitySlots[0]?.visual.label, "正在读取 other.ts");
});

test("projects delegation as its own aggregate semantic and promotes child status", () => {
  const delegated = activity(2, {
    delegation: {
      agentId: "explorer",
      childRunId: "run_child",
      childSessionId: "session_child",
      createdAt: "2026-07-20T10:00:02.000Z",
      delegationId: "delegation_1",
      message: "Inspect routing",
      status: "waiting",
      updatedAt: "2026-07-20T10:00:02.500Z"
    },
    kind: "delegation",
    tool: tool({
      action: "execute",
      callId: "call_delegate",
      effect: "control_only",
      normalizedTarget: "explorer",
      targetKind: "workspace",
      toolName: "delegate"
    })
  });
  const secondDelegated = activity(3, {
    delegation: {
      agentId: "worker",
      childRunId: "run_child2",
      childSessionId: "session_child2",
      createdAt: "2026-07-20T10:00:03.000Z",
      delegationId: "delegation_2",
      message: "Plan tests",
      status: "completed",
      updatedAt: "2026-07-20T10:00:03.500Z"
    },
    kind: "delegation",
    tool: tool({
      action: "execute",
      callId: "call_delegate_2",
      effect: "control_only",
      normalizedTarget: "worker",
      targetKind: "workspace",
      toolName: "delegate"
    })
  });
  const entries = projectDisplayTimeline(run([message(1, "我会委派调查。"), delegated, secondDelegated, message(4, "委派完成。")]));
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.semantic, "delegation");
  assert.equal(segment.aggregate?.status, "running");
  assert.equal(segment.aggregate?.summaryLabel, "委派 2 个子代理");
});

test("starts content after a tool-only segment without moving its aggregate header", () => {
  const toolOnly = [
    thinking(1, "completed"),
    activity(2),
    activity(3, { tool: tool({ callId: "call_3", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" }) })
  ];
  const before = projectDisplayTimeline(run(toolOnly));
  assert.equal(before[0].type === "display_segment" && before[0].segment.activitySlots[0]?.visual.label, "正在读取 other.ts");

  const after = projectDisplayTimeline(run([...toolOnly, message(4, "检查完成。")]));
  assert.equal(after.length, 2);
  assert.ok(after.every((entry) => entry.type === "display_segment"));
  if (after[0].type !== "display_segment" || after[1].type !== "display_segment") return;
  assert.equal(after[0].segment.mainActivity, undefined);
  assert.equal(after[0].segment.aggregate?.summaryLabel, "读取 2 个文件");
  assert.deepEqual(after[0].segment.activitySlots, []);
  assert.equal(after[1].segment.mainActivity?.body, "检查完成。");
});

test("projects render state without changing authoritative activity facts", () => {
  const completedRead = activity(2);
  const secondRead = activity(3, { tool: tool({ callId: "call_3", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" }) });
  const input = run([message(1, "开始。"), completedRead, secondRead, message(4, "完成。")]);
  const before = structuredClone(input.activities);
  const entries = projectDisplayTimeline(input);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  const segment = entries[0].segment;
  assert.equal(segment.aggregate?.summaryLabel, "读取 2 个文件");
  assert.deepEqual(input.activities, before);
  assert.equal(completedRead.status, "completed");
  assert.equal(completedRead.finishedAt, "2026-07-20T10:00:02.500Z");
});

test("uses suppressed final content as a boundary without rendering a duplicate main slot", () => {
  const finalContent = message(3, "最终答案。");
  const input = run([
    message(1, "先检查。"),
    activity(2),
    activity(5, { tool: tool({ callId: "call_5", displayTarget: "src/other.ts", normalizedTarget: "src/other.ts" }) }),
    thinking(4, "completed"),
    finalContent
  ]);
  const entries = projectDisplayTimeline(input, input.activities, {
    suppressedContentActivityIds: new Set([finalContent.activityId])
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  assert.equal(entries[0].segment.mainActivity?.body, "先检查。");
  assert.deepEqual(entries[0].segment.activitySlots, []);
  assert.equal(entries[0].segment.aggregate?.summaryLabel, "读取 2 个文件");
});

test("shows only the last running tool and falls back to the remaining tool", () => {
  const first = activity(2, { finishedAt: undefined, status: "running" });
  const second = activity(3, {
    finishedAt: undefined,
    status: "running",
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  });
  const running = onlySegment(run([message(1, "开始检查。"), first, second]));
  assert.deepEqual(running.activitySlots.map((slot) => slot.visual.label), ["正在读取 .env"]);
  assert.equal(running.aggregate, undefined);

  // One settled + one running: under the ≥2-settled aggregate rule there is no
  // aggregate yet; the live slot shows the running tool.
  const partiallySettled = onlySegment(run([message(1, "开始检查。"), activity(2), second]));
  assert.deepEqual(partiallySettled.activitySlots.map((slot) => slot.visual.label), ["正在读取 .env"]);
  assert.equal(partiallySettled.aggregate, undefined);

  const lastSettled = onlySegment(run([message(1, "开始检查。"), first, activity(3, {
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  })]));
  assert.deepEqual(lastSettled.activitySlots.map((slot) => slot.visual.label), ["正在读取 App.tsx"]);
  assert.equal(lastSettled.aggregate, undefined);
});
