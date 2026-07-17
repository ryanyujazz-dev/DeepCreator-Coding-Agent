import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SignalStore } from "../server/signalStore";

function register(store: SignalStore, sessionKey = "session_store") {
  return store.registerSession({
    compactThresholdTokens: 850_000,
    contextWindowTokens: 1_000_000,
    model: "deepseek-chat",
    projectRoot: "/tmp/project",
    sessionKey,
    title: "持久化测试"
  });
}

test("persists projections, replays logs, and resumes after an offset", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-store-"));
  try {
    const first = new SignalStore(directory);
    register(first);
    first.append({ cycleKey: "cycle_store", payload: { model: "deepseek-chat", prompt: "继续", startedAt: new Date().toISOString() }, sessionKey: "session_store", topic: "cycle.accepted" });
    first.append({ cycleKey: "cycle_store", payload: {}, sessionKey: "session_store", topic: "cycle.executing" });
    const checkpoint = first.getSession("session_store")!.lastOffset;
    first.close();

    const restored = new SignalStore(directory);
    const view = restored.getSession("session_store")!;
    assert.equal(view.cycles.length, 1);
    assert.equal(view.cycles[0].phase, "failed", "an interrupted cycle is settled on restart");
    const resumed = restored.readSignals("session_store", checkpoint);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].topic, "cycle.settled");
    assert.equal(restored.listSessions()[0].sessionKey, "session_store");
    assert.equal(restored.listSessions("持久化").length, 1);
    assert.equal(restored.listSessions("不存在的搜索词").length, 0);
    restored.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
