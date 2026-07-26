import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCompletion, finalTaskMaintenanceIssue } from "../server/app/completionGate";
import { emptyChanges, Run } from "../shared/contracts/runtime";

function run(overrides: Partial<Run> = {}): Run {
  return {
    activities: [],
    answer: "",
    approvals: [],
    changes: emptyChanges(),
    lastOffset: 0,
    mode: "work",
    model: "test",
    prompt: "test",
    runId: "run_completion",
    sessionId: "session_completion",
    startedAt: "2026-07-26T00:00:00.000Z",
    status: "running",
    tasks: [],
    ...overrides
  };
}

test("blocks final content while a managed command remains active", () => {
  const block = evaluateCompletion({ run: run(), runningCommandCount: 2 });
  assert.equal(block?.kind, "running_commands");
  assert.match(block?.retryMessage ?? "", /2 个托管命令/);
});

test("requires a final task update after the last work tool", () => {
  const current = run({
    activities: [{
      activityId: "activity_read",
      audience: "user",
      body: "",
      kind: "tool",
      runId: "run_completion",
      startedAt: "2026-07-26T00:00:01.000Z",
      status: "completed",
      tool: {
        action: "inspect",
        argumentsPreview: "{}",
        callId: "call_read",
        effect: "read_only",
        modelStepId: "step_read",
        normalizedTarget: "src/App.tsx",
        targetKind: "file",
        toolName: "read_file"
      }
    }],
    tasks: [{ label: "检查入口", status: "completed", taskId: "task_read" }]
  });
  assert.equal(finalTaskMaintenanceIssue(current), "最后一次 update_tasks 早于最后一次工作工具调用");
  assert.equal(evaluateCompletion({ run: current, runningCommandCount: 0 })?.kind, "task_maintenance");
});

test("accepts completion only after all Runtime-owned facts are terminal", () => {
  const current = run({
    activities: [{
      activityId: "activity_tasks",
      audience: "internal",
      body: "",
      kind: "tool",
      runId: "run_completion",
      startedAt: "2026-07-26T00:00:01.000Z",
      status: "completed",
      tool: {
        action: "task",
        argumentsPreview: "{}",
        callId: "call_tasks",
        effect: "control_only",
        modelStepId: "step_tasks",
        normalizedTarget: "任务清单",
        targetKind: "task",
        toolName: "update_tasks"
      }
    }],
    tasks: [{ label: "检查入口", status: "completed", taskId: "task_read" }]
  });
  assert.equal(evaluateCompletion({ run: current, runningCommandCount: 0 }), undefined);
});
