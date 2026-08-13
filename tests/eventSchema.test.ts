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
});

test("accepts a dedicated reasoning delta without provider protocol fields", () => {
  const reasoning = {
    ...startedEvent(),
    data: { modelStepId: "model_step_1", textDelta: "正在检查项目结构。" },
    eventId: "session_schema:3",
    offset: 3,
    type: "reasoning.updated"
  };
  assert.equal(eventSchema.safeParse(reasoning).success, true);
  assert.equal(eventSchema.safeParse({ ...reasoning, data: { reasoning_content: "private" } }).success, false);
});

test("validates durable reasoning titles", () => {
  const title = {
    ...startedEvent(),
    data: { title: "核对页面跳转参数" },
    eventId: "session_schema:4",
    offset: 4,
    type: "reasoning.title.updated"
  };
  assert.equal(eventSchema.safeParse(title).success, true);
  assert.equal(eventSchema.safeParse({ ...title, data: { title: "" } }).success, false);
  assert.equal(eventSchema.safeParse({ ...title, data: { title: "字".repeat(61) } }).success, false);
});

test("validates provider-neutral Responses output item lifecycle facts", () => {
  const outputItem = {
    ...startedEvent(),
    data: {
      item: {
        itemId: "item_1",
        modelStepId: "model_step_1",
        outputIndex: 0,
        sequence: 1,
        status: "generating",
        type: "custom",
        callId: "call_1",
        draft: "*** Begin Patch"
      }
    },
    eventId: "session_schema:5",
    offset: 5,
    type: "model.output_item.changed"
  };
  assert.equal(eventSchema.safeParse(outputItem).success, true);
  assert.equal(eventSchema.safeParse({ ...outputItem, data: { item: { ...outputItem.data.item, type: "raw_sse" } } }).success, false);
});

test("rejects unknown or incomplete V2 Events at the decoding boundary", () => {
  assert.equal(decodeEvent({ ...startedEvent(), type: "run.teleported" }), undefined);
  assert.equal(decodeEvent({ ...startedEvent(), scope: { sessionId: "session_schema" } }), undefined);
});

test("delegation events accept the reviewer agent id at the decoding boundary", () => {
  // reviewer 是批次 3.3 新增 AgentId;event schema 若漏更新,客户端 SSE 解析会抛错
  // 进入重连死循环,且 EventStore 重放会静默丢弃该事件。
  const delegationEvent = {
    at: "2026-08-13T00:00:00.000Z",
    data: {
      delegation: {
        agentId: "reviewer",
        childRunId: "run_child",
        childSessionId: "session_child",
        createdAt: "2026-08-13T00:00:00.000Z",
        deliveryStatus: "pending",
        delegationId: "delegation_1",
        message: "审查改动",
        parentActivityId: "activity_1",
        parentCallId: "call_1",
        parentRunId: "run_schema",
        parentSessionId: "session_schema",
        status: "running",
        updatedAt: "2026-08-13T00:00:00.000Z"
      }
    },
    eventId: "session_schema:9",
    offset: 9,
    scope: { sessionId: "session_schema" },
    type: "delegation.created",
    version: EVENT_VERSION
  };
  assert.equal(eventSchema.safeParse(delegationEvent).success, true);
  assert.equal(eventSchema.safeParse({
    ...delegationEvent,
    data: { delegation: { ...delegationEvent.data.delegation, agentId: "auditor" } }
  }).success, false);
});
