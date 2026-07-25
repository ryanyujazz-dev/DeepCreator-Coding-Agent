import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_VERSION, Event } from "../shared/contracts/runtime";
import { decodeEvent } from "../shared/legacy/decoder";
import { eventSchema } from "../shared/schemas/event";

function startedEvent(): Event<"run.started"> {
  return {
    at: "2026-07-22T00:00:00.000Z",
    data: {
      model: "mock-agent",
      prompt: "检查项目",
      startedAt: "2026-07-22T00:00:00.000Z"
    },
    eventId: "session_schema:2",
    offset: 2,
    scope: { runId: "run_schema", sessionId: "session_schema" },
    type: "run.started",
    version: EVENT_VERSION
  };
}

test("validates the payload selected by the Event type", () => {
  const parsed = eventSchema.safeParse(startedEvent());
  assert.equal(parsed.success, true);

  const invalid = eventSchema.safeParse({
    ...startedEvent(),
    data: { items: [] }
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.deepEqual(invalid.issues.map((issue) => issue.path), ["data"]);
});

test("accepts fact-only Activity Events and legacy rendered titles", () => {
  const activity = {
    at: "2026-07-22T00:00:01.000Z",
    data: { audience: "user", kind: "tool", startedAt: "2026-07-22T00:00:01.000Z" },
    eventId: "session_schema:3",
    offset: 3,
    scope: { activityId: "activity_schema", runId: "run_schema", sessionId: "session_schema" },
    type: "activity.started",
    version: EVENT_VERSION
  };
  assert.equal(eventSchema.safeParse(activity).success, true);
  assert.equal(eventSchema.safeParse({ ...activity, data: { ...activity.data, title: "Legacy label" } }).success, true);
  assert.equal(eventSchema.safeParse({
    ...activity,
    data: {
      ...activity.data,
      tool: {
        action: "inspect",
        argumentsPreview: "{}",
        callId: "call_schema",
        effect: "read_only",
        modelStepId: "step_schema",
        normalizedTarget: "src/App.tsx",
        statement: {
          groupId: "group_schema",
          mode: "new",
          statementId: "statement_schema",
          title: "Inspect project architecture"
        },
        targetKind: "file",
        toolName: "read_file"
      }
    }
  }).success, true);
  assert.equal(eventSchema.safeParse({
    ...activity,
    data: {
      audience: "internal",
      kind: "statement",
      startedAt: "2026-07-22T00:00:01.000Z",
      statement: {
        groupId: "group_schema",
        mode: "new",
        statementId: "statement_schema",
        title: "Inspect project architecture"
      }
    }
  }).success, true);
});

test("rejects unknown or incomplete V2 Events at the decoding boundary", () => {
  assert.equal(decodeEvent({ ...startedEvent(), type: "run.teleported" }), undefined);
  assert.equal(decodeEvent({ ...startedEvent(), scope: { sessionId: "session_schema" } }), undefined);
});
