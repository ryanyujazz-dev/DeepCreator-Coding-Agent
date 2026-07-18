import assert from "node:assert/strict";
import test from "node:test";
import { projectGroups } from "../shared/projections/groups";
import { createSession, rebuildSession, reduceEvent, reduceEvents } from "../shared/domain/reducer";
import { Event, EVENT_VERSION } from "../shared/contracts/runtime";

const registration = {
  compactThresholdTokens: 850_000,
  contextWindowTokens: 1_000_000,
  createdAt: "2026-07-17T10:00:00.000Z",
  model: "deepseek-chat",
  projectRoot: "/tmp/project",
  sessionId: "session_test",
  title: "测试会话"
};

function event(offset: number, type: Event["type"], data: unknown, activityId?: string): Event {
  return {
    version: EVENT_VERSION,
    at: `2026-07-17T10:00:0${offset}.000Z`,
    data,
    offset,
    scope: { runId: "run_test", sessionId: registration.sessionId, activityId },
    eventId: `session_test:${offset}`,
    type
  };
}

test("reduces lifecycle signals and treats settlement as authoritative", () => {
  const initial = createSession(registration, 1);
  const events = [
    event(2, "run.started", { model: "deepseek-chat", prompt: "修复测试", startedAt: "2026-07-17T10:00:02.000Z" }),
    event(4, "activity.started", { audience: "debug", kind: "thinking", startedAt: "2026-07-17T10:00:04.000Z", title: "" }, "activity_1"),
    event(5, "activity.updated", { bodyDelta: "检查上下文" }, "activity_1"),
    event(6, "activity.finished", { status: "completed", finishedAt: "2026-07-17T10:00:06.000Z" }, "activity_1"),
    event(7, "run.finished", { answer: "已完成", status: "completed", finishedAt: "2026-07-17T10:00:07.000Z" })
  ];
  const result = reduceEvents(initial, events);
  assert.equal(result.runs[0].status, "completed");
  assert.equal(result.runs[0].answer, "已完成");
  assert.equal(result.runs[0].activities[0].body, "检查上下文");
  assert.equal(result.runs[0].activities[0].status, "completed");
});

test("ignores duplicate and stale offsets", () => {
  const initial = createSession(registration, 1);
  const accepted = event(2, "run.started", { model: "deepseek-chat", prompt: "测试", startedAt: registration.createdAt });
  const once = reduceEvent(initial, accepted);
  const twice = reduceEvent(once, accepted);
  assert.equal(twice.runs.length, 1);
  assert.equal(twice.lastOffset, 2);
});

test("keeps the model-owned tasks unchanged when a run terminates unsuccessfully", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-chat", prompt: "修改代码", startedAt: registration.createdAt }),
    event(4, "tasks.changed", {
      items: [
        { label: "修改文件", status: "running", taskId: "edit" },
        { label: "运行测试", status: "pending", taskId: "test" }
      ]
    }),
    event(5, "run.finished", {
      error: "Runtime restarted",
      status: "failed",
      finishedAt: "2026-07-17T10:00:05.000Z"
    })
  ]);
  assert.equal(result.runs[0].tasks[0].status, "running");
  assert.equal(result.runs[0].tasks[1].status, "pending");
});

test("replay produces the same semantic activity projection as live reduction", () => {
  const registered: Event = {
    version: EVENT_VERSION,
    at: registration.createdAt,
    offset: 1,
    data: registration,
    scope: { sessionId: registration.sessionId },
    eventId: "session_test:1",
    type: "session.created"
  };
  const toolFact = {
    groupMode: "consecutive" as const,
    argumentsPreview: "{\"path\":\"src/App.tsx\"}",
    callId: "call_replay",
    detail: { defaultCollapsed: true, pathStyle: "workspace_relative" as const, previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effect: "read_only" as const,
    importance: "routine" as const,
    modelStepId: "model_step_replay",
    normalizedTarget: "src/App.tsx",
    action: "inspect" as const,
    targetKind: "file" as const,
    toolName: "read_file"
  };
  const events = [
    event(2, "run.started", { model: registration.model, prompt: "检查文件", startedAt: registration.createdAt }),
    event(4, "activity.started", {
      audience: "user",
      kind: "tool",
      startedAt: "2026-07-17T10:00:04.000Z",
      title: "读取文件",
      tool: toolFact
    }, "unit_replay"),
    event(5, "activity.updated", {
      tool: { resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    event(6, "activity.finished", {
      status: "completed",
      finishedAt: "2026-07-17T10:00:06.000Z",
      tool: { ...toolFact, resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    event(7, "run.finished", { answer: "检查完成", status: "completed", finishedAt: "2026-07-17T10:00:07.000Z" })
  ];

  const live = reduceEvents(createSession(registration, 1), events);
  const replayed = rebuildSession([registered, ...events]);
  assert.ok(replayed);
  assert.deepEqual(replayed, live);
  assert.deepEqual(
    projectGroups(replayed.runs[0]),
    projectGroups(live.runs[0])
  );
});
