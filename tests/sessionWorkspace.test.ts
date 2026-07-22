import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureScratchWorkspace, scratchWorkspacePath } from "../server/infra/sessionWorkspace";
import { RuntimeStore } from "../server/infra/runtimeStore";

test("creates stable isolated scratch directories without exposing the session id", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-scratch-"));
  try {
    const first = await ensureScratchWorkspace(directory, "session-one");
    const repeated = await ensureScratchWorkspace(directory, "session-one");
    const second = await ensureScratchWorkspace(directory, "session-two");

    assert.equal(first, repeated);
    assert.equal(first, scratchWorkspacePath(directory, "session-one"));
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), path.join(directory, "scratch-workspaces"));
    assert.equal(path.basename(first).length, 64);
    assert.equal(path.basename(first).includes("session-one"), false);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("persists scratch workspace identity across Runtime restarts and archive", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-scratch-store-"));
  const sessionId = "session-persisted-scratch";
  try {
    const workspace = await ensureScratchWorkspace(directory, sessionId);
    const marker = path.join(workspace, "kept.txt");
    writeFileSync(marker, "kept", "utf8");
    const first = new RuntimeStore(directory);
    first.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "mock-agent",
      projectRoot: workspace,
      sessionId,
      title: "临时任务",
      workspaceKind: "scratch"
    });
    first.close();

    const second = new RuntimeStore(directory);
    assert.equal(second.getSession(sessionId)?.workspaceKind, "scratch");
    assert.equal(second.getSession(sessionId)?.projectRoot, workspace);
    assert.equal(second.updateSessionSidebar(sessionId, { archived: true }), true);
    assert.equal(second.listSessions().some((session) => session.sessionId === sessionId), false);
    assert.equal(existsSync(marker), true);
    second.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
