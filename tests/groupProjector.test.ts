import assert from "node:assert/strict";
import test from "node:test";
import { projectGroups } from "../shared/projections/groups";
import {
  Activity,
  Run,
  emptyChanges,
  ToolState
} from "../shared/contracts/runtime";

function tool(overrides: Partial<ToolState> = {}): ToolState {
  return {
    groupMode: "consecutive",
    argumentsPreview: "{}",
    callId: "call_1",
    detail: { defaultCollapsed: true, pathStyle: "workspace_relative", previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effect: "read_only",
    importance: "routine",
    modelStepId: "step_1",
    normalizedTarget: "src/App.tsx",
    action: "inspect",
    targetKind: "file",
    toolName: "read_file",
    ...overrides
  };
}

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    audience: "user",
    body: "",
    runId: "run_projection",
    kind: "tool",
    startedAt: `2026-07-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    status: "completed",
    finishedAt: `2026-07-17T10:00:${String(index).padStart(2, "0")}.500Z`,
    title: "读取文件",
    tool: tool({ callId: `call_${index}` }),
    activityId: `unit_${index}`,
    ...overrides
  };
}

function run(activities: Activity[], status: Run["status"] = "completed"): Run {
  return {
    approvals: [],
    runId: "run_projection",
    answer: "",
    lastOffset: activities.length,
    model: "test",
    mode: "work",
    status,
    tasks: [],
    prompt: "test",
    sessionId: "session_projection",
    startedAt: "2026-07-17T10:00:00.000Z",
    activities,
    changes: emptyChanges()
  };
}

test("coalesces thirty reads into one stable group without losing calls", () => {
  const activities = Array.from({ length: 30 }, (_, index) => activity(index + 1, {
    tool: tool({
      callId: `call_${index + 1}`,
      displayTarget: `src/file-${index + 1}.ts`,
      modelStepId: `step_${Math.floor(index / 3)}`,
      normalizedTarget: `src/file-${index + 1}.ts`
    })
  }));
  const projection = projectGroups(run(activities));
  assert.equal(projection.length, 1);
  assert.equal(projection[0].type, "activity_group");
  if (projection[0].type !== "activity_group") return;
  assert.equal(projection[0].group.totalCalls, 30);
  assert.equal(projection[0].group.uniqueTargets.length, 30);
  assert.equal(projection[0].group.summaryLabel, "已检查 30 个文件");
  assert.deepEqual(projection[0].group.memberActivityIds, activities.map((item) => item.activityId));
});

test("keeps Skill activity standalone and splits legacy groups on both sides", () => {
  const skill = activity(2, {
    body: "release-electron instructions",
    tool: tool({
      callId: "call_skill",
      displayTarget: "skill:release-electron",
      groupMode: "standalone",
      normalizedTarget: "skill:release-electron",
      targetKind: "workspace",
      toolName: "invoke_capability"
    })
  });
  const projection = projectGroups(run([
    activity(1),
    skill,
    activity(3, { tool: tool({ callId: "call_3" }) })
  ]));

  assert.deepEqual(projection.map((entry) => entry.type), ["activity_group", "activity", "activity_group"]);
  assert.equal(projection[1].type === "activity" && projection[1].activity.activityId, skill.activityId);
});

test("deduplicates targets while preserving real call count across model steps", () => {
  const projection = projectGroups(run([
    activity(1, { tool: tool({ callId: "a", modelStepId: "step_a" }) }),
    activity(2, { tool: tool({ callId: "b", modelStepId: "step_b" }) })
  ]));
  assert.equal(projection[0].type, "activity_group");
  if (projection[0].type !== "activity_group") return;
  assert.equal(projection[0].group.totalCalls, 2);
  assert.deepEqual(projection[0].group.uniqueTargets, ["src/App.tsx"]);
  assert.equal(projection[0].group.detailRows[0].totalCalls, 2);
});

test("visible model content seals inspection groups but completed thinking does not", () => {
  const thinking = activity(2, { audience: "debug", kind: "thinking", status: "completed", tool: undefined });
  const message = activity(4, { body: "接下来修改状态流。", kind: "message", tool: undefined });
  const projection = projectGroups(run([
    activity(1),
    thinking,
    activity(3, { tool: tool({ callId: "call_3", displayTarget: "src/main.tsx", normalizedTarget: "src/main.tsx" }) }),
    message,
    activity(5, { tool: tool({ callId: "call_5", displayTarget: "src/styles.css", normalizedTarget: "src/styles.css" }) })
  ]));
  assert.deepEqual(projection.map((entry) => entry.type), ["activity_group", "activity", "activity_group"]);
  assert.equal(projection[0].type === "activity_group" && projection[0].group.totalCalls, 2);
});

test("keeps failed commands inside command groups with an explicit failure summary", () => {
  const command = activity(2, {
    kind: "command",
    tool: tool({
      groupMode: "standalone",
      callId: "command",
      displayTarget: "npm install",
      effect: "process_side_effect",
      importance: "notable",
      normalizedTarget: "npm install",
      action: "execute",
      targetKind: "process",
      toolName: "run_command"
    })
  });
  const secondCommand = activity(3, {
    kind: "command",
    tool: tool({
      groupMode: "standalone",
      callId: "command_2",
      displayTarget: "python3 -m py_compile app/main.py",
      effect: "process_side_effect",
      importance: "notable",
      normalizedTarget: "python3 -m py_compile app/main.py",
      action: "execute",
      targetKind: "process",
      toolName: "run_command"
    })
  });
  const failedCommand = activity(4, {
    error: "missing",
    kind: "command",
    status: "failed",
    tool: tool({
      groupMode: "standalone",
      callId: "command_3",
      displayTarget: "npm run build",
      effect: "process_side_effect",
      importance: "notable",
      normalizedTarget: "npm run build",
      action: "execute",
      targetKind: "process",
      toolName: "run_command"
    })
  });
  const projection = projectGroups(run([activity(1), command, secondCommand, failedCommand]));
  assert.deepEqual(projection.map((entry) => entry.type), ["activity_group", "activity_group"]);
  assert.equal(projection[1].type === "activity_group" && projection[1].group.summaryLabel, "已运行 3 条命令 · 1 条失败");
  assert.equal(projection[1].type === "activity_group" && projection[1].group.failureCount, 1);
});

test("renders one failed command as a collapsible command group", () => {
  const failedCommand = activity(1, {
    kind: "command",
    status: "failed",
    tool: tool({
      groupMode: "standalone",
      displayTarget: "npm run dev:h5",
      effect: "process_side_effect",
      normalizedTarget: "npm run dev:h5",
      action: "execute",
      targetKind: "process",
      toolName: "run_command"
    })
  });
  const projection = projectGroups(run([failedCommand]));
  assert.equal(projection[0].type, "activity_group");
  assert.equal(projection[0].type === "activity_group" && projection[0].group.summaryLabel, "命令运行失败");
  assert.deepEqual(projection[0].type === "activity_group" && projection[0].group.memberActivityIds, [failedCommand.activityId]);
});

test("hides plan updates without splitting a surrounding inspection group", () => {
  const plan = activity(2, {
    kind: "tool",
    title: "更新计划",
    tool: tool({
      groupMode: "standalone",
      callId: "plan",
      displayTarget: "当前计划",
      effect: "control_only",
      normalizedTarget: "当前计划",
      action: "task",
      targetKind: "task",
      toolName: "update_tasks"
    })
  });
  const projection = projectGroups(run([
    activity(1),
    plan,
    activity(3, { tool: tool({ callId: "after-plan", displayTarget: "src/main.ts", normalizedTarget: "src/main.ts" }) })
  ]));
  assert.equal(projection.length, 1);
  assert.equal(projection[0].type === "activity_group" && projection[0].group.totalCalls, 2);
  assert.equal(projection[0].type === "activity_group" && projection[0].group.summaryLabel, "已检查 2 个文件");
});

test("keeps a submitted Plan as an independent timeline projection", () => {
  const submittedPlan = activity(2, {
    body: "## 实施步骤\n\n1. 调整 Runtime",
    kind: "plan",
    title: "Runtime 实施计划",
    tool: tool({
      groupMode: "standalone",
      callId: "submitted-plan",
      displayTarget: "实施方案",
      effect: "control_only",
      normalizedTarget: "实施方案",
      action: "plan",
      targetKind: "task",
      toolName: "submit_plan"
    })
  });
  const projection = projectGroups(run([activity(1), submittedPlan]));
  assert.equal(projection.length, 2);
  assert.equal(projection[1].type, "activity");
  assert.equal(projection[1].type === "activity" && projection[1].activity.activityId, submittedPlan.activityId);
});

test("uses authoritative workspace delta for modification summaries", () => {
  const modification = activity(1, {
    kind: "file_mutation",
    tool: tool({
      groupMode: "workspace_delta",
      displayTarget: "src/App.tsx",
      effect: "workspace_write",
      importance: "notable",
      normalizedTarget: "src/App.tsx",
      action: "modify",
      toolName: "edit_file"
    })
  });
  const input = run([modification]);
  input.changes = {
    additions: 22,
    comparisonBase: "run_start",
    deletions: 4,
    fileCount: 1,
    files: [{ additions: 22, deletions: 4, operation: "edited", path: "src/App.tsx" }]
  };
  const projection = projectGroups(input);
  assert.equal(projection[0].type, "activity_group");
  if (projection[0].type !== "activity_group") return;
  assert.equal(projection[0].group.summaryLabel, "已修改 1 个文件 +22 -4");
  assert.deepEqual(projection[0].group.changes, { additions: 22, deletions: 4, fileCount: 1 });
});

test("projects standalone file mutations through the unified activity group", () => {
  const deletion = activity(1, {
    kind: "file_mutation",
    tool: tool({
      groupMode: "standalone",
      displayTarget: "src/legacy.ts",
      effect: "workspace_write",
      importance: "notable",
      normalizedTarget: "src/legacy.ts",
      action: "modify",
      toolName: "delete_file"
    })
  });
  const input = run([deletion]);
  input.changes = {
    additions: 0,
    comparisonBase: "run_start",
    deletions: 18,
    fileCount: 1,
    files: [{ additions: 0, deletions: 18, operation: "deleted", path: "src/legacy.ts" }]
  };

  const projection = projectGroups(input);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].type, "activity_group");
  assert.equal(projection[0].type === "activity_group" && projection[0].group.category, "modify");
  assert.equal(projection[0].type === "activity_group" && projection[0].group.summaryLabel, "已修改 1 个文件 +0 -18");
});

test.skip("updates the live group in place with a current target", () => {
  const first = activity(1);
  const before = projectGroups(run([first]));
  const running = activity(2, {
    status: "running",
    finishedAt: undefined,
    tool: tool({ callId: "running", displayTarget: "src/runtime.ts", normalizedTarget: "src/runtime.ts" })
  });
  const after = projectGroups(run([first, running]));
  assert.equal(before[0].entryId, after[0].entryId);
  assert.equal(after[0].type === "activity_group" && after[0].group.summaryLabel, "正在检查 2 个文件");
  assert.equal(after[0].type === "activity_group" && after[0].group.currentTarget, "src/runtime.ts");
});

test("reuses one live-step slot when thinking turns into tool work", () => {
  const historical = activity(1, { tool: tool({ callId: "history", modelStepId: "step_a" }) });
  const thinking = activity(2, {
    audience: "debug",
    finishedAt: undefined,
    kind: "thinking",
    modelStepId: "step_b",
    status: "running",
    tool: undefined
  });
  const before = projectGroups(run([historical, thinking], "running"));
  const runningTool = activity(3, {
    finishedAt: undefined,
    status: "running",
    tool: tool({ callId: "running", displayTarget: "src/runtime.ts", modelStepId: "step_b", normalizedTarget: "src/runtime.ts" })
  });
  const after = projectGroups(run([historical, thinking, runningTool], "running"));
  assert.equal(before.at(-1)?.type, "live_step");
  assert.equal(after.at(-1)?.type, "live_step");
  assert.equal(before.at(-1)?.entryId, after.at(-1)?.entryId);
  assert.deepEqual(after.map((entry) => entry.type), ["activity_group", "live_step"]);
  assert.equal(after[1].type === "live_step" && after[1].liveStep.mode, "tools");
  assert.equal(after[1].type === "live_step" && after[1].liveStep.mode === "tools" && after[1].liveStep.status, "running");
});

test("keeps the latest settled tool step live until the next step begins", () => {
  const historical = activity(1, { tool: tool({ callId: "history", modelStepId: "step_a" }) });
  const settledThinking = activity(2, {
    audience: "debug",
    kind: "thinking",
    modelStepId: "step_b",
    status: "completed",
    tool: undefined
  });
  const settledTool = activity(3, {
    tool: tool({ callId: "settled", displayTarget: "src/runtime.ts", modelStepId: "step_b", normalizedTarget: "src/runtime.ts" })
  });
  const beforeNextStep = projectGroups(run([historical, settledThinking, settledTool], "running"));
  assert.deepEqual(beforeNextStep.map((entry) => entry.type), ["activity_group", "live_step"]);
  assert.equal(beforeNextStep[0].type === "activity_group" && beforeNextStep[0].group.totalCalls, 1);
  assert.equal(beforeNextStep[1].type === "live_step" && beforeNextStep[1].liveStep.mode, "tools");
  assert.equal(beforeNextStep[1].type === "live_step" && beforeNextStep[1].liveStep.mode === "tools" && beforeNextStep[1].liveStep.status, "completed");

  const nextThinking = activity(4, {
    audience: "debug",
    finishedAt: undefined,
    kind: "thinking",
    modelStepId: "step_c",
    status: "running",
    tool: undefined
  });
  const afterNextStepStarts = projectGroups(run([historical, settledThinking, settledTool, nextThinking], "running"));
  assert.deepEqual(afterNextStepStarts.map((entry) => entry.type), ["activity_group", "live_step"]);
  assert.equal(beforeNextStep.at(-1)?.entryId, afterNextStepStarts.at(-1)?.entryId);
  assert.equal(afterNextStepStarts[0].type === "activity_group" && afterNextStepStarts[0].group.totalCalls, 2);
  assert.equal(afterNextStepStarts[1].type === "live_step" && afterNextStepStarts[1].liveStep.mode, "thinking");
});
