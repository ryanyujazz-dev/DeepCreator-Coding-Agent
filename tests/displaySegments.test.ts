import assert from "node:assert/strict";
import test from "node:test";
import { projectDisplayTimeline } from "../shared/projections/displaySegments";
import { fileDisplayName } from "../shared/projections/activityPresentation";
import { Activity, Run, ToolState, ToolUseStatement, emptyChanges } from "../shared/contracts/runtime";

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

function statement(index: number, value: ToolUseStatement): Activity {
  return activity(index, {
    audience: "internal",
    kind: "statement",
    modelStepId: `step_${index}`,
    statement: value,
    tool: undefined
  });
}

function run(activities: Activity[], status: Run["status"] = "running"): Run {
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
    status,
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

test("does not project later thinking after visible progress exists", () => {
  const segment = onlySegment(run([message(1, "我先检查一下配置文件。"), thinking(2)]));
  assert.equal(segment.mainActivity?.activityId, "activity_1");
  assert.deepEqual(segment.activitySlots, []);
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
  assert.deepEqual(after.activitySlots, []);
});

test("shows a declared aggregate while its tools are running", () => {
  const runningRead = activity(2, {
    finishedAt: undefined,
    status: "running",
    tool: tool({
      statement: {
        groupId: "group_inspect",
        mode: "new",
        statementId: "statement_1",
        title: "获取分析所需项目信息"
      }
    })
  });
  const segment = onlySegment(run([runningRead]));
  assert.equal(segment.aggregate?.status, "running");
  assert.equal(segment.aggregate?.title, "获取分析所需项目信息");
  assert.equal(segment.aggregate?.summaryLabel, "");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2"]);
});

test("removes settled activity slots while showing the next active transient", () => {
  const content = message(1, "我先检查一下配置文件。");
  const completedRead = activity(2);
  const held = onlySegment(run([content, completedRead]));
  const nextRead = activity(3, {
    finishedAt: undefined,
    status: "running",
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  });
  const active = onlySegment(run([content, completedRead, nextRead]));
  assert.deepEqual(held.activitySlots, []);
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
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件 · 已编辑 1 个文件");
  assert.deepEqual(segment.aggregate?.memberActivityIds, ["activity_2", "activity_3"]);
});

test("does not leave completed thinking behind after a tool segment", () => {
  const firstContent = message(1, "第一段。");
  const firstTool = activity(2);
  const nextThinking = thinking(3, "completed");
  const beforeContent = projectDisplayTimeline(run([firstContent, firstTool, nextThinking]));
  assert.equal(beforeContent.length, 1);
  assert.deepEqual(beforeContent[0].type === "display_segment" && beforeContent[0].segment.activitySlots, []);

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

test("uses statement groups as boundaries even when no content appears", () => {
  const firstStatement = {
    groupId: "group_inspect",
    mode: "new" as const,
    statementId: "statement_1",
    title: "获取分析所需项目信息"
  };
  const secondStatement = {
    groupId: "group_implement",
    mode: "new" as const,
    statementId: "statement_2",
    title: "实现工具分组协议"
  };
  const entries = projectDisplayTimeline(run([
    activity(1, { tool: tool({ statement: firstStatement }) }),
    activity(2, {
      tool: tool({
        callId: "call_2",
        normalizedTarget: "src/main.tsx",
        statement: { ...firstStatement, mode: "continue" }
      })
    }),
    activity(3, {
      kind: "file_mutation",
      tool: tool({
        action: "modify",
        callId: "call_3",
        effect: "workspace_write",
        normalizedTarget: "src/App.tsx",
        statement: secondStatement,
        toolName: "edit_file"
      })
    })
  ]));

  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.type === "display_segment"));
  if (entries[0].type !== "display_segment" || entries[1].type !== "display_segment") return;
  assert.equal(entries[0].segment.aggregate?.title, "获取分析所需项目信息");
  assert.deepEqual(entries[0].segment.aggregate?.memberActivityIds, ["activity_1", "activity_2"]);
  assert.equal(entries[1].segment.aggregate?.title, "实现工具分组协议");
  assert.deepEqual(entries[1].segment.aggregate?.memberActivityIds, ["activity_3"]);
});

test("does not split a statement group on its standalone declaration thinking", () => {
  const statement = {
    groupId: "group_inspect",
    mode: "new" as const,
    statementId: "statement_1",
    title: "审查项目源代码与配置"
  };
  const firstTool = activity(1, {
    modelStepId: "step_tool_1",
    tool: tool({
      callId: "call_1",
      modelStepId: "step_tool_1",
      statement
    })
  });
  const declarationThinking = thinking(2, "completed");
  const secondTool = activity(3, {
    modelStepId: "step_tool_2",
    tool: tool({
      callId: "call_2",
      modelStepId: "step_tool_2",
      statement: {
        ...statement,
        mode: "continue",
        statementId: "statement_2"
      }
    })
  });

  const entries = projectDisplayTimeline(run([
    firstTool,
    declarationThinking,
    secondTool
  ]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  assert.equal(entries[0].segment.aggregate?.title, "审查项目源代码与配置");
  assert.deepEqual(
    entries[0].segment.aggregate?.memberActivityIds,
    ["activity_1", "activity_3"]
  );
});

test("keeps a statement active while the model digests completed tool facts", () => {
  const firstStatement: ToolUseStatement = {
    groupId: "group_inspect",
    mode: "new",
    statementId: "statement_1",
    title: "审查项目结构与现状"
  };
  const secondStatement: ToolUseStatement = {
    groupId: "group_implement",
    mode: "new",
    statementId: "statement_2",
    title: "实现路由与导航结构"
  };
  const completedRead = activity(3, {
    tool: tool({
      callId: "call_3",
      statement: firstStatement
    })
  });
  const digestThinking = thinking(4, "completed");

  const activeEntries = projectDisplayTimeline(run([
    thinking(1, "suspended"),
    statement(2, firstStatement),
    completedRead,
    digestThinking
  ]));
  assert.equal(activeEntries.length, 1);
  assert.equal(activeEntries[0].type, "display_segment");
  if (activeEntries[0].type !== "display_segment") return;
  assert.equal(activeEntries[0].segment.aggregate?.title, "审查项目结构与现状");
  assert.equal(activeEntries[0].segment.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.equal(activeEntries[0].segment.aggregate?.status, "running");
  assert.deepEqual(activeEntries[0].segment.activitySlots, []);

  const switchedEntries = projectDisplayTimeline(run([
    thinking(1, "suspended"),
    statement(2, firstStatement),
    completedRead,
    digestThinking,
    statement(5, secondStatement)
  ]));
  assert.equal(switchedEntries.length, 2);
  assert.ok(switchedEntries.every((entry) => entry.type === "display_segment"));
  if (switchedEntries[0].type !== "display_segment" || switchedEntries[1].type !== "display_segment") return;
  assert.equal(switchedEntries[0].segment.aggregate?.status, "completed");
  assert.equal(switchedEntries[1].segment.aggregate?.title, "实现路由与导航结构");
  assert.equal(switchedEntries[1].segment.aggregate?.status, "running");

  const waitingEntries = projectDisplayTimeline(run([
    thinking(1, "suspended"),
    statement(2, firstStatement),
    completedRead,
    statement(5, secondStatement)
  ], "waiting"));
  assert.ok(waitingEntries.every((entry) =>
    entry.type !== "display_segment" || entry.segment.aggregate?.status !== "running"
  ));
});

test("supports a completed tool-only segment without a stale live label", () => {
  const segment = onlySegment(run([thinking(1, "completed"), activity(2)]));
  assert.equal(segment.mainActivity, undefined);
  assert.equal(segment.aggregate?.summaryLabel, "已读取 1 个文件");
  assert.deepEqual(segment.activitySlots, []);
});

test("starts content after a tool-only segment without moving its aggregate header", () => {
  const toolOnly = [thinking(1, "completed"), activity(2)];
  const before = projectDisplayTimeline(run(toolOnly));
  assert.deepEqual(before[0].type === "display_segment" && before[0].segment.activitySlots, []);

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

test("allocates one stable activity slot per concurrent tool and removes only the settled slot", () => {
  const first = activity(2, { finishedAt: undefined, status: "running" });
  const second = activity(3, {
    finishedAt: undefined,
    status: "running",
    tool: tool({ callId: "call_3", displayTarget: ".env", normalizedTarget: ".env" })
  });
  const running = onlySegment(run([message(1, "开始检查。"), first, second]));
  assert.deepEqual(running.activitySlots.map((slot) => slot.visual.label), ["正在读取 App.tsx", "正在读取 .env"]);

  const partiallySettled = onlySegment(run([message(1, "开始检查。"), activity(2), second]));
  assert.deepEqual(partiallySettled.activitySlots.map((slot) => slot.visual.label), ["正在读取 .env"]);
  assert.deepEqual(partiallySettled.aggregate?.memberActivityIds, ["activity_2"]);
});
