import assert from "node:assert/strict";
import test from "node:test";
import { Activity } from "../shared/contracts/runtime";
import {
  formatActivityElapsed,
  runningCommandElapsed
} from "../shared/projections/activityTiming";

function commandActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: "activity_command",
    audience: "user",
    body: "",
    kind: "command",
    runId: "run_command",
    startedAt: "2026-07-20T10:00:00.000Z",
    status: "running",
    title: "运行命令",
    tool: {
      action: "execute",
      argumentsPreview: "{}",
      callId: "call_command",
      detail: { defaultCollapsed: true, pathStyle: "raw", previewLimit: 5 },
      displayTarget: "npm test",
      effect: "process_side_effect",
      groupMode: "standalone",
      importance: "notable",
      modelStepId: "model_step_command",
      normalizedTarget: "npm test",
      targetKind: "process",
      toolName: "run_command"
    },
    ...overrides
  };
}

test("reveals a running command timer only after 24 seconds", () => {
  const activity = commandActivity();
  assert.equal(runningCommandElapsed(activity, Date.parse("2026-07-20T10:00:24.999Z")), undefined);
  assert.equal(runningCommandElapsed(activity, Date.parse("2026-07-20T10:00:25.000Z")), "25s");
  assert.equal(runningCommandElapsed({ ...activity, status: "completed" }, Date.parse("2026-07-20T10:01:00.000Z")), undefined);
});

test("formats longer command durations without losing seconds", () => {
  assert.equal(formatActivityElapsed(65), "1m 05s");
  assert.equal(formatActivityElapsed(7_385), "2h 03m 05s");
});
