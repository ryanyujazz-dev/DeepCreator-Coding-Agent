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

test("holds suspended thinking visually without treating it as terminal", () => {
  const held = onlySegment(run([thinking(1, "suspended")]));
  assert.equal(held.activitySlots[0]?.logicalState, "empty");
  assert.equal(held.activitySlots[0]?.visual.label, "正在思考");

  const runningRead = activity(2, { finishedAt: undefined, status: "running" });
  const active = onlySegment(run([thinking(1, "suspended"), runningRead]));
  assert.equal(active.activitySlots[0]?.logicalState, "active");
  assert.equal(active.activitySlots[0]?.visual.label, "正在读取 App.tsx");
});

test("creates no empty aggregate on tool start and creates it immediately on done", () => {
  const content = message(1, "我先检查一下配置文件。");
  const runningRead = activity(2, { finishedAt: undefined, status: "running" });
  const before = onlySegment(run([content, runningRead]));
  assert.equal(before.aggregate, undefined);
  assert.equal(before.activitySlots[0]?.visual.label, "正在读取 App.tsx");

  const completedRead = activity(2);
  const after = onlySegment(run([content, completedRead]));
  assert.equal(after.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.equal(after.aggregate?.status, "completed");
  assert.equal(after.activitySlots[0]?.logicalState, "empty");
  assert.equal(after.activitySlots[0]?.visual.label, "正在读取 App.tsx");
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
  const segment = onlySegment(run([
    message(1, "开始处理。"),
    activity(2),
    edit
  ]));
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件 · 已编辑 1 个文件");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2", "activity_3"]);
});

test("uses the sealed step headline before every tool in that step has started", () => {
  const segment = onlySegment(run([
    message(1, "开始处理。"),
    activity(2, { tool: tool({ stepHeadline: "modify" }) })
  ]));
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件");
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
  const segment = onlySegment(run([message(1, "开始处理。"), activity(2), failedEdit]));
  assert.equal(segment.aggregate?.headlineLabel, "修改项目文件");
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件 · 1 项失败");
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
  const segment = onlySegment(run([message(1, "启动数据库。"), successful, failed]));
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
  const segment = onlySegment(run([message(1, "继续检查。"), legacyFailure]));
  assert.equal(segment.aggregate?.failureCount, 1);
  assert.equal(segment.aggregate?.status, "failed");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2"]);
});

test("starts a new segment only when the next content arrives", () => {
  const firstContent = message(1, "第一段。");
  const firstTool = activity(2);
  const nextThinking = thinking(3, "completed");
  const beforeContent = projectDisplayTimeline(run([firstContent, firstTool, nextThinking]));
  assert.equal(beforeContent.length, 1);
  assert.equal(beforeContent[0].type === "display_segment" && beforeContent[0].segment.activitySlots[0]?.visual.label, "正在读取 App.tsx");

  const entries = projectDisplayTimeline(run([
    firstContent,
    firstTool,
    nextThinking,
    message(4, "第二段。"),
    activity(5, {
      tool: tool({ callId: "call_5", displayTarget: "src/next.ts", normalizedTarget: "src/next.ts" })
    })
  ]));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.type === "display_segment"));
  if (entries[0].type !== "display_segment" || entries[1].type !== "display_segment") return;
  assert.deepEqual(entries[0].segment.aggregate?.memberActivityIds, ["activity_2"]);
  assert.deepEqual(entries[1].segment.aggregate?.memberActivityIds, ["activity_5"]);
  assert.deepEqual(entries[0].segment.activitySlots, []);
  assert.equal(entries[1].segment.mainActivity?.body, "第二段。");
});

test("supports a tool-only segment while preserving the held start label", () => {
  const segment = onlySegment(run([thinking(1, "completed"), activity(2)]));
  assert.equal(segment.mainActivity, undefined);
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.equal(segment.activitySlots[0]?.logicalState, "empty");
  assert.equal(segment.activitySlots[0]?.visual.label, "正在读取 App.tsx");
});

test("starts content after a tool-only segment without moving its aggregate header", () => {
  const toolOnly = [thinking(1, "completed"), activity(2)];
  const before = projectDisplayTimeline(run(toolOnly));
  assert.equal(before[0].type === "display_segment" && before[0].segment.activitySlots[0]?.visual.label, "正在读取 App.tsx");

  const after = projectDisplayTimeline(run([...toolOnly, message(3, "检查完成。")]));
  assert.equal(after.length, 2);
  assert.ok(after.every((entry) => entry.type === "display_segment"));
  if (after[0].type !== "display_segment" || after[1].type !== "display_segment") return;
  assert.equal(after[0].segment.mainActivity, undefined);
  assert.equal(after[0].segment.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.deepEqual(after[0].segment.activitySlots, []);
  assert.equal(after[1].segment.mainActivity?.body, "检查完成。");
});

test("projects render state without changing authoritative activity facts", () => {
  const completedRead = activity(2);
  const input = run([message(1, "开始。"), completedRead]);
  const before = structuredClone(input.activities);
  const segment = onlySegment(input);
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.deepEqual(input.activities, before);
  assert.equal(completedRead.status, "completed");
  assert.equal(completedRead.finishedAt, "2026-07-20T10:00:02.500Z");
});

test("uses suppressed final content as a boundary without rendering a duplicate main slot", () => {
  const finalContent = message(3, "最终答案。");
  const input = run([message(1, "先检查。"), activity(2), thinking(4, "completed"), finalContent]);
  const entries = projectDisplayTimeline(input, input.activities, {
    suppressedContentActivityIds: new Set([finalContent.activityId])
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  assert.equal(entries[0].segment.mainActivity?.body, "先检查。");
  assert.deepEqual(entries[0].segment.activitySlots, []);
  assert.equal(entries[0].segment.aggregate?.summaryLabel, "已读取 1 个文件");
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

  const partiallySettled = onlySegment(run([message(1, "开始检查。"), activity(2), second]));
  assert.deepEqual(partiallySettled.activitySlots.map((slot) => slot.visual.label), ["正在读取 .env"]);
  assert.deepEqual(partiallySettled.aggregate?.memberActivityIds, ["activity_2"]);
  assert.equal(partiallySettled.aggregate?.status, "running");

  const lastSettled = onlySegment(run([message(1, "开始检查。"), first, activity(3, {
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  })]));
  assert.deepEqual(lastSettled.activitySlots.map((slot) => slot.visual.label), ["正在读取 App.tsx"]);
  assert.equal(lastSettled.aggregate?.status, "running");
});
