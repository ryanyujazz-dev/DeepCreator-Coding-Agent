import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultContextConfig } from "../server/app/contextBuilder";
import { FollowUpService } from "../server/app/followUps";
import { LaunchRunInput, RunLaunchPort } from "../server/app/runLauncher";
import { RunRegistry } from "../server/app/runRegistry";
import { StartRun } from "../server/app/startRun";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { testSystem } from "./support/system";

function createHarness(directory: string) {
  let sequence = 0;
  const system = {
    ...testSystem,
    createId: (prefix: string) => `${prefix}_${sequence += 1}`,
    now: () => "2026-07-27T01:38:16.000Z"
  };
  const store = new RuntimeStore(directory);
  const launched: LaunchRunInput[] = [];
  const launcher: RunLaunchPort = { launch: (input) => launched.push(input) };
  const startRun = new StartRun({
    context: defaultContextConfig,
    defaultModel: "mock-agent",
    launcher,
    store,
    system,
    workspace: { canonicalize: path.resolve, ensureScratch: async () => directory, resolveProjectRoot: async () => directory },
    workspaceRoot: directory
  });
  const registry = new RunRegistry(system);
  const followUps = new FollowUpService({ registry, startRun, store, system });
  store.createSession({
    compactThresholdTokens: 850_000,
    contextWindowTokens: 1_000_000,
    model: "mock-agent",
    projectRoot: directory,
    sessionId: "session_follow_up",
    title: "排队测试"
  });
  store.append({
    data: { model: "mock-agent", prompt: "当前任务", startedAt: system.now() },
    runId: "run_current",
    sessionId: "session_follow_up",
    type: "run.started"
  });
  return { followUps, launched, registry, store, system };
}

test("persists a queued follow-up and can steer it into the active Run", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-follow-up-steer-"));
  const { followUps, registry, store } = createHarness(directory);
  try {
    registry.startRun("run_current");
    const queued = await followUps.queue({
      accessMode: "request_approval",
      mode: "work",
      model: "mock-agent",
      planEntry: "suggest",
      prompt: "先核对悬浮输入框",
      sessionId: "session_follow_up"
    });
    assert.equal(queued.session.followUps.length, 1);
    const followUpId = queued.session.followUps[0].followUpId;

    const steered = followUps.steer("session_follow_up", followUpId);
    assert.equal(steered.session.followUps.length, 0);
    assert.equal(steered.session.runs[0].activities.at(-1)?.kind, "user_message");
    assert.equal(steered.session.runs[0].activities.at(-1)?.body, "先核对悬浮输入框");
    assert.equal(steered.session.runs[0].activities.at(-1)?.status, "completed");
    assert.equal(store.readContextEntries("session_follow_up").filter((entry) =>
      entry.metadata?.steerId === followUpId && entry.kind === "human_text"
    ).length, 1);
    assert.deepEqual(registry.takeSteers("run_current"), [{
      prompt: "先核对悬浮输入框",
      steerId: followUpId
    }]);
    assert.deepEqual(store.readEvents("session_follow_up").slice(-4).map((event) => event.type), [
      "follow_up.queued",
      "follow_up.removed",
      "activity.started",
      "activity.finished"
    ]);
  } finally {
    followUps.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("steering aborts the active interruptible step after persisting the user message", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-follow-up-preempt-"));
  const { followUps, registry, store } = createHarness(directory);
  try {
    registry.startRun("run_current");
    const step = registry.beginInterruptibleStep("run_current");
    const queued = await followUps.queue({
      accessMode: "request_approval",
      mode: "work",
      model: "mock-agent",
      planEntry: "suggest",
      prompt: "立即改为检查测试",
      sessionId: "session_follow_up"
    });
    followUps.steer("session_follow_up", queued.session.followUps[0].followUpId);

    assert.equal(step.signal.aborted, true);
    assert.equal(step.interruptedBySteer(), true);
    assert.equal(store.getRun("run_current")?.activities.at(-1)?.kind, "user_message");
    step.release();
  } finally {
    followUps.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("starts the next queued prompt automatically after the active Run finishes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-follow-up-drain-"));
  const { followUps, launched, store, system } = createHarness(directory);
  try {
    await followUps.queue({
      accessMode: "full_access",
      mode: "work",
      model: "mock-agent",
      planEntry: "auto",
      prompt: "运行排队任务",
      sessionId: "session_follow_up"
    });
    store.append({
      data: { answer: "当前任务完成", finishedAt: system.now(), status: "completed" },
      runId: "run_current",
      sessionId: "session_follow_up",
      type: "run.finished"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const session = store.getSession("session_follow_up")!;
    assert.equal(session.followUps.length, 0);
    assert.equal(session.runs.at(-1)?.prompt, "运行排队任务");
    assert.equal(session.runs.at(-1)?.status, "running");
    assert.equal(launched.at(-1)?.prompt, "运行排队任务");
    assert.deepEqual(store.readEvents("session_follow_up").slice(-2).map((event) => event.type), [
      "follow_up.removed",
      "run.started"
    ]);
  } finally {
    followUps.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
