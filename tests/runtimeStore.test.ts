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
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-store-"));
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

test("persists pinned and archived sidebar state without changing session history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-sidebar-state-"));
  try {
    const first = new RuntimeStore(directory);
    register(first, "session_sidebar_a");
    register(first, "session_sidebar_b");

    assert.equal(first.updateSessionSidebar("session_sidebar_a", { pinned: true }), true);
    assert.equal(first.listSessions()[0].sessionId, "session_sidebar_a");
    assert.equal(first.listSessions()[0].pinned, true);

    assert.equal(first.updateSessionSidebar("session_sidebar_a", { archived: true }), true);
    assert.deepEqual(first.listSessions().map((session) => session.sessionId), ["session_sidebar_b"]);
    assert.equal(first.getSession("session_sidebar_a")?.title, "持久化测试", "archive metadata must not mutate the event-sourced session");

    assert.equal(first.updateSessionSidebar("session_sidebar_a", { archived: false }), true);
    assert.equal(first.archiveProjectSessions("/tmp/project"), 2);
    assert.equal(first.listSessions().length, 0);
    first.close();

    const restored = new RuntimeStore(directory);
    assert.equal(restored.listSessions().length, 0);
    assert.equal(restored.getSession("session_sidebar_a")?.title, "持久化测试");
    restored.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
