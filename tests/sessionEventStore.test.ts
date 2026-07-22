import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventStore } from "../src/features/runtime/sessionEventStore";
import { EVENT_VERSION, Event, SessionInput } from "../shared/contracts/runtime";
import { createSession } from "../shared/domain/reducer";

const input: SessionInput = {
  accessMode: "request_approval",
  compactThresholdTokens: 80_000,
  contextWindowTokens: 100_000,
  createdAt: "2026-07-22T00:00:00.000Z",
  model: "mock-agent",
  projectRoot: "/workspace",
  sessionId: "session_store",
  title: "Store"
};

test("keeps snapshots and Event reduction behind one client-side authority", () => {
  const store = new SessionEventStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications += 1);
  store.replaceSnapshot(createSession(input));
  const started: Event<"run.started"> = {
    at: "2026-07-22T00:00:01.000Z",
    data: { mode: "work", model: "mock-agent", prompt: "go", startedAt: "2026-07-22T00:00:01.000Z" },
    eventId: "event_1",
    offset: 1,
    scope: { runId: "run_1", sessionId: input.sessionId },
    type: "run.started",
    version: EVENT_VERSION
  };
  store.applyEvents(input.sessionId, [started]);
  assert.equal(store.getSnapshot()?.runs.at(-1)?.runId, "run_1");
  assert.equal(store.getSnapshot()?.lastOffset, 1);
  store.replaceSnapshot(createSession(input));
  assert.equal(store.getSnapshot()?.lastOffset, 1, "a stale REST snapshot must not roll Event state back");
  assert.equal(notifications, 2);
  unsubscribe();
});
