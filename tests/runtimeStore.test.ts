import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeStore } from "../server/infra/runtimeStore";

function register(store: RuntimeStore, sessionId = "session_store") {
  return store.createSession({
    compactThresholdTokens: 850_000,
    contextWindowTokens: 1_000_000,
    model: "deepseek-chat",
    projectRoot: "/tmp/project",
    sessionId,
    title: "持久化测试"
  });
}

test("persists projections, replays logs, and resumes after an offset", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-store-"));
  try {
    const first = new RuntimeStore(directory);
    register(first);
    first.append({ runId: "run_store", data: { model: "deepseek-chat", prompt: "继续", startedAt: new Date().toISOString() }, sessionId: "session_store", type: "run.started" });
    const checkpoint = first.getSession("session_store")!.lastOffset;
    first.close();

    const restored = new RuntimeStore(directory);
    const view = restored.getSession("session_store")!;
    assert.equal(view.runs.length, 1);
    assert.equal(view.runs[0].status, "failed", "an interrupted run is settled on restart");
    const resumed = restored.readEvents("session_store", checkpoint);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].type, "run.finished");
    assert.equal(restored.listSessions()[0].sessionId, "session_store");
    assert.equal(restored.listSessions("持久化").length, 1);
    assert.equal(restored.listSessions("不存在的搜索词").length, 0);
    restored.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
