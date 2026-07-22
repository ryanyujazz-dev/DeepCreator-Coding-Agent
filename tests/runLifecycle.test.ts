import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { finishRun } from "../server/app/runLifecycle";
import { RuntimeStore } from "../server/infra/runtimeStore";

test("does not leave a managed command activity running after agent completion", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-background-run-"));
  const store = new RuntimeStore(directory);
  try {
    store.createSession({
      accessMode: "full_access",
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_background",
      title: "background command"
    });
    store.append({
      data: { model: "test", prompt: "启动服务", startedAt: new Date().toISOString() },
      runId: "run_background",
      sessionId: "session_background",
      type: "run.started"
    });
    store.append({
      activityId: "activity_background",
      data: {
        audience: "user",
        command: { command: "npm run dev", commandId: "command_background", state: "running" },
        kind: "command",
        startedAt: new Date().toISOString(),
        title: "运行命令"
      },
      runId: "run_background",
      sessionId: "session_background",
      type: "activity.started"
    });

    finishRun({
      answer: "服务已经启动。",
      projectRoot: directory,
      runId: "run_background",
      sessionId: "session_background",
      status: "completed",
      store
    });

    const run = store.getRun("run_background")!;
    assert.equal(run.status, "completed");
    assert.equal(run.activities[0].status, "completed");
    assert.equal(run.activities[0].command?.commandId, "command_background");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("finishes a suspended thinking activity exactly once", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-suspended-thinking-"));
  const store = new RuntimeStore(directory);
  try {
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_suspended_thinking",
      title: "suspended thinking"
    });
    store.append({
      data: { model: "test", prompt: "检查项目", startedAt: new Date().toISOString() },
      runId: "run_suspended_thinking",
      sessionId: "session_suspended_thinking",
      type: "run.started"
    });
    store.append({
      activityId: "activity_thinking",
      data: {
        audience: "user",
        kind: "thinking",
        startedAt: new Date().toISOString(),
        title: "正在思考"
      },
      runId: "run_suspended_thinking",
      sessionId: "session_suspended_thinking",
      type: "activity.started"
    });
    store.append({
      activityId: "activity_thinking",
      data: { status: "suspended" as const },
      runId: "run_suspended_thinking",
      sessionId: "session_suspended_thinking",
      type: "activity.updated"
    });

    const suspended = store.getRun("run_suspended_thinking")!.activities[0];
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.finishedAt, undefined);

    finishRun({
      answer: "检查完成。",
      projectRoot: directory,
      runId: "run_suspended_thinking",
      sessionId: "session_suspended_thinking",
      status: "completed",
      store
    });

    const finishedEvents = store.readEvents("session_suspended_thinking")
      .filter((event) => event.type === "activity.finished" && event.scope.activityId === "activity_thinking");
    assert.equal(finishedEvents.length, 1);
    assert.equal(store.getRun("run_suspended_thinking")!.activities[0].status, "completed");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("persists one interrupted result for every unfinished tool call", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-interrupted-tools-"));
  const store = new RuntimeStore(directory);
  try {
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_interrupted_tools",
      title: "interrupted tools"
    });
    store.append({
      data: { model: "test", prompt: "读取文件", startedAt: new Date().toISOString() },
      runId: "run_interrupted_tools",
      sessionId: "session_interrupted_tools",
      type: "run.started"
    });
    store.appendContextEntry({
      kind: "agent_text",
      runId: "run_interrupted_tools",
      sessionId: "session_interrupted_tools",
      source: "model",
      toolCalls: [
        { argumentsText: "{}", callId: "call_a", index: 0, name: "list_files" },
        { argumentsText: "{}", callId: "call_b", index: 1, name: "git_status" }
      ]
    });
    store.appendContextEntry({
      kind: "tool_result",
      runId: "run_interrupted_tools",
      sessionId: "session_interrupted_tools",
      source: "tool",
      text: "clean",
      toolCallKey: "call_b",
      toolName: "git_status"
    });

    const finish = () => finishRun({
      answer: "运行已取消。",
      error: "用户取消了运行。",
      failureType: "cancelled",
      projectRoot: directory,
      runId: "run_interrupted_tools",
      sessionId: "session_interrupted_tools",
      status: "cancelled",
      store
    });
    finish();
    finish();

    const results = store.readContextEntries("session_interrupted_tools")
      .filter((entry) => entry.kind === "tool_result");
    assert.deepEqual(results.map((entry) => entry.toolCallKey).sort(), ["call_a", "call_b"]);
    assert.equal(results.filter((entry) => entry.toolCallKey === "call_a").length, 1);
    assert.equal(results.find((entry) => entry.toolCallKey === "call_a")?.metadata?.synthetic, true);
    assert.equal(store.getRun("run_interrupted_tools")?.status, "cancelled");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("startup recovery closes tool calls left open by a Runtime restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-restart-tools-"));
  const first = new RuntimeStore(directory);
  first.createSession({
    compactThresholdTokens: 850_000,
    contextWindowTokens: 1_000_000,
    model: "test",
    projectRoot: directory,
    sessionId: "session_restart_tools",
    title: "restart tools"
  });
  first.append({
    data: { model: "test", prompt: "读取文件", startedAt: new Date().toISOString() },
    runId: "run_restart_tools",
    sessionId: "session_restart_tools",
    type: "run.started"
  });
  first.appendContextEntry({
    kind: "agent_text",
    runId: "run_restart_tools",
    sessionId: "session_restart_tools",
    source: "model",
    toolCalls: [{ argumentsText: "{}", callId: "call_restart", index: 0, name: "list_files" }]
  });
  first.close();

  const restored = new RuntimeStore(directory);
  try {
    assert.equal(restored.getRun("run_restart_tools")?.status, "failed");
    const result = restored.readContextEntries("session_restart_tools")
      .find((entry) => entry.toolCallKey === "call_restart");
    assert.equal(result?.kind, "tool_result");
    assert.equal(result?.metadata?.synthetic, true);
  } finally {
    restored.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("startup repairs tool calls missing from an already terminal historical run", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-terminal-tools-"));
  const first = new RuntimeStore(directory);
  first.createSession({
    compactThresholdTokens: 850_000,
    contextWindowTokens: 1_000_000,
    model: "test",
    projectRoot: directory,
    sessionId: "session_terminal_tools",
    title: "terminal tools"
  });
  first.append({
    data: { model: "test", prompt: "读取文件", startedAt: new Date().toISOString() },
    runId: "run_terminal_tools",
    sessionId: "session_terminal_tools",
    type: "run.started"
  });
  first.appendContextEntry({
    kind: "agent_text",
    runId: "run_terminal_tools",
    sessionId: "session_terminal_tools",
    source: "model",
    toolCalls: [{ argumentsText: "{}", callId: "call_terminal", index: 0, name: "list_files" }]
  });
  first.append({
    data: {
      answer: "本次运行未能完成。",
      error: "legacy failure",
      finishedAt: new Date().toISOString(),
      status: "failed" as const
    },
    runId: "run_terminal_tools",
    sessionId: "session_terminal_tools",
    type: "run.finished"
  });
  first.close();

  const restored = new RuntimeStore(directory);
  try {
    const results = restored.readContextEntries("session_terminal_tools")
      .filter((entry) => entry.toolCallKey === "call_terminal");
    assert.equal(results.length, 1);
    assert.equal(results[0].metadata?.synthetic, true);
    assert.match(results[0].text ?? "", /历史运行已处于 failed 状态/);
  } finally {
    restored.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
