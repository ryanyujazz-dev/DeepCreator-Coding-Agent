import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultContextConfig } from "../server/app/contextBuilder";
import { LaunchRunInput, RunLaunchPort } from "../server/app/runLauncher";
import { StartRun, StartRunError } from "../server/app/startRun";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { testSystem } from "./support/system";

test("starts a Run through an application use case without transport concerns", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-start-run-"));
  const store = new RuntimeStore(directory);
  const launched: LaunchRunInput[] = [];
  const launcher: RunLaunchPort = { launch: (input) => launched.push(input) };
  const useCase = new StartRun({
    context: defaultContextConfig,
    defaultModel: "mock-agent",
    launcher,
    store,
    system: { ...testSystem, createId: () => "run_use_case", now: () => "2026-07-22T00:00:00.000Z" },
    workspace: { canonicalize: path.resolve, ensureScratch: async () => directory, resolveProjectRoot: async () => directory },
    workspaceRoot: directory
  });
  try {
    const result = await useCase.execute({ prompt: "先规划企业架构，不要修改", sessionId: "session_use_case" });
    assert.equal(result.session.mode, "plan");
    assert.equal(result.run.runId, "run_use_case");
    assert.deepEqual(launched, [{
      model: "mock-agent",
      projectRoot: directory,
      prompt: "先规划企业架构，不要修改",
      runId: "run_use_case",
      sessionId: "session_use_case"
    }]);
    assert.deepEqual(store.readEvents("session_use_case").map((event) => event.type), ["session.created", "run.started"]);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("enforces workspace identity before launching an existing Session", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-start-run-lock-"));
  const store = new RuntimeStore(directory);
  const useCase = new StartRun({
    context: defaultContextConfig,
    defaultModel: "mock-agent",
    launcher: { launch: () => undefined },
    store,
    system: { ...testSystem, createId: () => "run_locked", now: () => "2026-07-22T00:00:00.000Z" },
    workspace: { canonicalize: path.resolve, ensureScratch: async () => directory, resolveProjectRoot: async () => directory },
    workspaceRoot: directory
  });
  try {
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "mock-agent",
      projectRoot: directory,
      sessionId: "session_locked",
      title: "locked"
    });
    await assert.rejects(
      useCase.execute({ projectRoot: path.join(directory, "other"), prompt: "继续", sessionId: "session_locked" }),
      (error: unknown) => error instanceof StartRunError && error.kind === "conflict"
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
