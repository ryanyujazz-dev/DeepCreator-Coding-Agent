import assert from "node:assert/strict";
import test from "node:test";
import { projectOperationGroups } from "../shared/operationGroupProjector";
import {
  ActivityUnitView,
  CycleView,
  emptyWorkspaceDelta,
  ToolExecutionView
} from "../shared/runtimeTypes";

function tool(overrides: Partial<ToolExecutionView> = {}): ToolExecutionView {
  return {
    aggregationPolicy: "consecutive",
    argumentsPreview: "{}",
    callKey: "call_1",
    detailPolicy: { defaultCollapsed: true, pathStyle: "workspace_relative", previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effectKind: "read_only",
    importance: "routine",
    modelStepKey: "step_1",
    normalizedTarget: "src/App.tsx",
    operationClass: "inspect",
    resourceKind: "file",
    toolName: "read_file",
    ...overrides
  };
}

function unit(index: number, overrides: Partial<ActivityUnitView> = {}): ActivityUnitView {
  return {
    audience: "user",
    body: "",
    cycleKey: "cycle_projection",
    kind: "tool",
    openedAt: `2026-07-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    phase: "succeeded",
    sealedAt: `2026-07-17T10:00:${String(index).padStart(2, "0")}.500Z`,
    title: "读取文件",
    tool: tool({ callKey: `call_${index}` }),
    unitKey: `unit_${index}`,
    ...overrides
  };
}

function cycle(units: ActivityUnitView[]): CycleView {
  return {
    approvals: [],
    cycleKey: "cycle_projection",
    finalResponse: "",
    lastOffset: units.length,
    model: "test",
    phase: "active",
    plan: [],
    prompt: "test",
    sessionKey: "session_projection",
    startedAt: "2026-07-17T10:00:00.000Z",
    units,
    workspaceDelta: emptyWorkspaceDelta()
  };
}

test("coalesces thirty reads into one stable group without losing calls", () => {
  const units = Array.from({ length: 30 }, (_, index) => unit(index + 1, {
    tool: tool({
      callKey: `call_${index + 1}`,
      displayTarget: `src/file-${index + 1}.ts`,
      modelStepKey: `step_${Math.floor(index / 3)}`,
      normalizedTarget: `src/file-${index + 1}.ts`
    })
  }));
  const projection = projectOperationGroups(cycle(units));
  assert.equal(projection.length, 1);
  assert.equal(projection[0].type, "operation_group");
  if (projection[0].type !== "operation_group") return;
  assert.equal(projection[0].group.totalCalls, 30);
  assert.equal(projection[0].group.uniqueTargets.length, 30);
  assert.equal(projection[0].group.summaryLabel, "已检查 30 个文件");
  assert.deepEqual(projection[0].group.memberUnitKeys, units.map((item) => item.unitKey));
});

test("deduplicates targets while preserving real call count across model steps", () => {
  const projection = projectOperationGroups(cycle([
    unit(1, { tool: tool({ callKey: "a", modelStepKey: "step_a" }) }),
    unit(2, { tool: tool({ callKey: "b", modelStepKey: "step_b" }) })
  ]));
  assert.equal(projection[0].type, "operation_group");
  if (projection[0].type !== "operation_group") return;
  assert.equal(projection[0].group.totalCalls, 2);
  assert.deepEqual(projection[0].group.uniqueTargets, ["src/App.tsx"]);
  assert.equal(projection[0].group.detailRows[0].totalCalls, 2);
});

test("visible model content seals inspection groups but completed thinking does not", () => {
  const thinking = unit(2, { audience: "debug", kind: "thinking", phase: "succeeded", tool: undefined });
  const message = unit(4, { body: "接下来修改状态流。", kind: "message", tool: undefined });
  const projection = projectOperationGroups(cycle([
    unit(1),
    thinking,
    unit(3, { tool: tool({ callKey: "call_3", displayTarget: "src/main.tsx", normalizedTarget: "src/main.tsx" }) }),
    message,
    unit(5, { tool: tool({ callKey: "call_5", displayTarget: "src/styles.css", normalizedTarget: "src/styles.css" }) })
  ]));
  assert.deepEqual(projection.map((entry) => entry.type), ["operation_group", "activity_unit", "operation_group"]);
  assert.equal(projection[0].type === "operation_group" && projection[0].group.totalCalls, 2);
});

test("groups consecutive successful commands but keeps failures standalone", () => {
  const command = unit(2, {
    kind: "command",
    tool: tool({
      aggregationPolicy: "standalone",
      callKey: "command",
      displayTarget: "npm install",
      effectKind: "process_side_effect",
      importance: "notable",
      normalizedTarget: "npm install",
      operationClass: "execute",
      resourceKind: "process",
      toolName: "run_command"
    })
  });
  const secondCommand = unit(3, {
    kind: "command",
    tool: tool({
      aggregationPolicy: "standalone",
      callKey: "command_2",
      displayTarget: "python3 -m py_compile app/main.py",
      effectKind: "process_side_effect",
      importance: "notable",
      normalizedTarget: "python3 -m py_compile app/main.py",
      operationClass: "execute",
      resourceKind: "process",
      toolName: "run_command"
    })
  });
  const failed = unit(4, { error: "missing", phase: "failed", tool: tool({ callKey: "failed" }) });
  const projection = projectOperationGroups(cycle([unit(1), command, secondCommand, failed]));
  assert.deepEqual(projection.map((entry) => entry.type), ["operation_group", "operation_group", "activity_unit"]);
  assert.equal(projection[1].type === "operation_group" && projection[1].group.summaryLabel, "已运行 2 条命令");
});

test("uses authoritative workspace delta for modification summaries", () => {
  const modification = unit(1, {
    kind: "file_mutation",
    tool: tool({
      aggregationPolicy: "workspace_delta",
      displayTarget: "src/App.tsx",
      effectKind: "workspace_write",
      importance: "notable",
      normalizedTarget: "src/App.tsx",
      operationClass: "modify",
      toolName: "edit_file"
    })
  });
  const input = cycle([modification]);
  input.workspaceDelta = {
    additions: 22,
    comparisonBase: "cycle_start",
    deletions: 4,
    fileCount: 1,
    files: [{ additions: 22, deletions: 4, operation: "edited", path: "src/App.tsx" }]
  };
  const projection = projectOperationGroups(input);
  assert.equal(projection[0].type, "operation_group");
  if (projection[0].type !== "operation_group") return;
  assert.equal(projection[0].group.summaryLabel, "已修改 1 个文件 +22 -4");
  assert.deepEqual(projection[0].group.workspaceDelta, { additions: 22, deletions: 4, fileCount: 1 });
});

test("updates the live group in place with a current target", () => {
  const first = unit(1);
  const before = projectOperationGroups(cycle([first]));
  const running = unit(2, {
    phase: "open",
    sealedAt: undefined,
    tool: tool({ callKey: "running", displayTarget: "src/runtime.ts", normalizedTarget: "src/runtime.ts" })
  });
  const after = projectOperationGroups(cycle([first, running]));
  assert.equal(before[0].entryKey, after[0].entryKey);
  assert.equal(after[0].type === "operation_group" && after[0].group.summaryLabel, "正在检查 2 个文件");
  assert.equal(after[0].type === "operation_group" && after[0].group.currentTarget, "src/runtime.ts");
});
