import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../server/app/runner";
import { RunRegistry } from "../server/app/runRegistry";
import { Provider } from "../shared/contracts/provider";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";

test("recovers a transient provider failure before any stream fragment", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-"));
  try {
    let attempts = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        attempts += 1;
        if (attempts === 1) throw new Error("DeepSeek API 请求失败：503 unavailable");
        request.onFragment?.({ kind: "answer", text: "恢复成功" });
        return {
          answer: "恢复成功",
          continuationMessage: { role: "assistant", text: "恢复成功" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_retry", title: "重试" });
    store.append({ runId: "run_retry", data: { model: "test", prompt: "你好", startedAt: new Date().toISOString() }, sessionId: "session_retry", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_retry");
    await runAgent({ tools: toolHost, runId: "run_retry", model: "test", projectRoot: directory, prompt: "你好", provider, registry, sessionId: "session_retry", signal: controller.signal, store });
    const run = store.getRun("run_retry")!;
    assert.equal(attempts, 2);
    assert.equal(run.status, "completed");
    assert.equal(run.answer, "恢复成功");
    assert.equal(run.activities.some((activity) => activity.kind === "error"), false);
    assert.ok(store.readContextEntries("session_retry").some((record) =>
      record.kind === "runtime_fact" && record.metadata?.transient === true
    ));
    const answerStart = store.readEvents("session_retry").find((event) =>
      event.type === "activity.started" && (event.data as { kind?: string }).kind === "message"
    );
    assert.equal((answerStart?.data as { body?: string }).body, "恢复成功");
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("persists semantic tool facts while provider schemas stay presentation-free", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-tool-"));
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    let turn = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        turn += 1;
        assert.ok(request.tools.every((tool) => !("presentation" in tool)));
        if (turn === 1) {
          const declaration = {
            argumentsText: JSON.stringify({ mode: "new", title: "读取代码文件" }),
            callId: "call_read_statement",
            index: 0,
            name: "tools_use_statement"
          };
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [declaration] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [declaration]
          };
        }
        if (turn === 2) {
          request.onFragment?.({
            argumentsText: "{\"path\":\"sample.ts\"}",
            callId: "call_read",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callId: "call_read", index: 0, name: "read_file" }]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [{ argumentsText: "{\"path\":\"sample.ts\"}", callId: "call_read", index: 0, name: "read_file" }]
          };
        }
        request.onFragment?.({ kind: "answer", text: "检查完成" });
        return {
          answer: "检查完成",
          continuationMessage: { role: "assistant", text: "检查完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_tool", title: "工具语义" });
    store.append({ runId: "run_tool", data: { model: "test", prompt: "读取代码文件", startedAt: new Date().toISOString() }, sessionId: "session_tool", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_tool");
    await runAgent({ tools: toolHost, runId: "run_tool", model: "test", projectRoot: directory, prompt: "读取代码文件", provider, registry, sessionId: "session_tool", signal: controller.signal, store });
    const run = store.getRun("run_tool")!;
    const readUnit = run.activities.find((activity) => activity.tool?.callId === "call_read");
    assert.equal(readUnit?.kind, "tool");
    assert.equal(readUnit?.tool?.action, "inspect");
    assert.equal(readUnit?.tool?.normalizedTarget, "sample.ts");
    assert.equal(readUnit?.tool?.resultMetrics?.itemCount, 1);
    assert.ok(readUnit?.tool?.modelStepId.startsWith("model_step_"));
    const events = store.readEvents("session_tool");
    assert.ok(events.some((event) => event.type === "activity.updated"));
    for (const event of events) {
      if (event.type !== "activity.started" && event.type !== "activity.updated" && event.type !== "activity.finished") continue;
      assert.equal("title" in event.data, false, "new Activity Events persist facts, not rendered labels");
      const persistedTool = event.data.tool;
      if (!persistedTool) continue;
      assert.equal("displayTarget" in persistedTool, false);
      assert.equal("groupMode" in persistedTool, false);
      assert.equal("importance" in persistedTool, false);
      assert.equal("detail" in persistedTool, false);
    }
    store.close();
  } finally {
    try {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM" && process.platform === "win32")) throw error;
    }
  }
});

test("records tool-use statements without creating a visible control activity", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-tool-statement-"));
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    let turn = 0;
    let sawStatementResult = false;
    const statementCall = {
      argumentsText: JSON.stringify({ mode: "new", title: "Inspect project architecture" }),
      callId: "call_statement",
      index: 0,
      name: "tools_use_statement"
    };
    const readCall = {
      argumentsText: JSON.stringify({ path: "sample.ts" }),
      callId: "call_read",
      index: 0,
      name: "read_file"
    };
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        turn += 1;
        if (turn === 1) {
          request.onFragment?.({ kind: "thinking", text: "initial reasoning" });
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [statementCall]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [statementCall]
          };
        }
        if (turn === 2) {
          sawStatementResult = request.messages.some((message) =>
            message.role === "tool" && message.toolCallKey === statementCall.callId
          );
          request.onFragment?.({ kind: "thinking", text: "digesting declaration" });
          request.onFragment?.({
            argumentsText: readCall.argumentsText,
            callId: readCall.callId,
            index: readCall.index,
            kind: "tool_call",
            name: readCall.name
          });
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [readCall]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [readCall]
          };
        }
        request.onFragment?.({ kind: "thinking", text: "digesting tool facts" });
        request.onFragment?.({ kind: "answer", text: "检查完成" });
        return {
          answer: "检查完成",
          continuationMessage: { role: "assistant", text: "检查完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_statement",
      title: "工具声明"
    });
    store.append({
      data: { model: "test", prompt: "读取代码文件", startedAt: new Date().toISOString() },
      runId: "run_statement",
      sessionId: "session_statement",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_statement");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "读取代码文件",
      provider,
      registry,
      runId: "run_statement",
      sessionId: "session_statement",
      signal: controller.signal,
      store,
      tools: toolHost
    });

    const run = store.getRun("run_statement")!;
    const readActivity = run.activities.find((activity) => activity.tool?.callId === readCall.callId);
    const statementActivity = run.activities.find((activity) => activity.kind === "statement");
    assert.equal(sawStatementResult, true);
    assert.equal(run.activities.some((activity) => activity.tool?.toolName === "tools_use_statement"), false);
    assert.equal(run.activities.filter((activity) => activity.kind === "thinking").length, 1);
    assert.equal(statementActivity?.audience, "internal");
    assert.equal(statementActivity?.statement?.title, "Inspect project architecture");
    assert.equal(readActivity?.tool?.statement?.title, "Inspect project architecture");
    assert.equal(readActivity?.tool?.statement?.mode, "new");
    assert.ok(store.readContextEntries("session_statement").some((record) =>
      record.kind === "tool_result" && record.toolCallKey === statementCall.callId
    ));
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("rejects undeclared tools without executing or projecting them", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-tool-statement-gate-"));
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    let turn = 0;
    const invalidRead = {
      argumentsText: JSON.stringify({ path: "missing.ts" }),
      callId: "call_invalid_read",
      index: 0,
      name: "read_file"
    };
    const statement = {
      argumentsText: JSON.stringify({ mode: "new", title: "读取项目文件" }),
      callId: "call_statement_gate",
      index: 0,
      name: "tools_use_statement"
    };
    const validRead = {
      argumentsText: JSON.stringify({ path: "sample.ts" }),
      callId: "call_valid_read",
      index: 0,
      name: "read_file"
    };
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        turn += 1;
        if (turn === 1) {
          request.onFragment?.({ ...invalidRead, kind: "tool_call" });
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [invalidRead] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [invalidRead]
          };
        }
        if (turn === 2) {
          assert.ok(request.messages.some((message) =>
            message.role === "tool"
            && message.toolCallKey === invalidRead.callId
            && message.text?.includes("缺少有效且独立的 tools_use_statement")
          ));
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [statement] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [statement]
          };
        }
        if (turn === 3) {
          request.onFragment?.({ ...validRead, kind: "tool_call" });
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [validRead] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [validRead]
          };
        }
        return {
          answer: "读取完成",
          continuationMessage: { role: "assistant", text: "读取完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_statement_gate",
      title: "声明门禁"
    });
    store.append({
      data: { model: "test", prompt: "读取代码文件", startedAt: new Date().toISOString() },
      runId: "run_statement_gate",
      sessionId: "session_statement_gate",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_statement_gate");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "读取代码文件",
      provider,
      registry,
      runId: "run_statement_gate",
      sessionId: "session_statement_gate",
      signal: controller.signal,
      store,
      tools: toolHost
    });

    const run = store.getRun("run_statement_gate")!;
    assert.equal(run.status, "completed");
    assert.equal(run.activities.some((activity) => activity.tool?.callId === invalidRead.callId), false);
    assert.equal(run.activities.some((activity) => activity.tool?.callId === statement.callId), false);
    assert.equal(run.activities.find((activity) => activity.tool?.callId === validRead.callId)?.tool?.statement?.title, "读取项目文件");
    assert.ok(store.readContextEntries("session_statement_gate").some((record) =>
      record.kind === "tool_result" && record.toolCallKey === invalidRead.callId && record.isError
    ));
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("publishes streamed and authoritative file diffs before mutation settlement", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-runtime-mutation-"));
  try {
    const eventToolHost = {
      ...toolHost,
      capture: async () => ({ available: true, files: new Map(), snapshotDirectory: path.join(directory, "unused-baseline") }),
      changes: async () => existsSync(path.join(directory, "created.ts")) ? {
        additions: 2,
        comparisonBase: "run_start" as const,
        deletions: 0,
        fileCount: 1,
        files: [{
          additions: 2,
          deletions: 0,
          operation: "created" as const,
          patch: "diff --git a/created.ts b/created.ts\n--- /dev/null\n+++ b/created.ts\n@@ -0,0 +1,2 @@\n+export const one = 1;\n+export const two = 2;",
          path: "created.ts"
        }]
      } : { additions: 0, comparisonBase: "run_start" as const, deletions: 0, fileCount: 0, files: [] },
      checkpoint: async () => undefined,
      close: async () => undefined
    };
    let turn = 0;
    const argumentsText = JSON.stringify({ path: "created.ts", content: "export const one = 1;\nexport const two = 2;\n" });
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        turn += 1;
        if (turn === 1) {
          const declaration = {
            argumentsText: JSON.stringify({ mode: "new", title: "创建代码文件" }),
            callId: "call_write_statement",
            index: 0,
            name: "tools_use_statement"
          };
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [declaration] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [declaration]
          };
        }
        if (turn === 2) {
          for (let index = 0; index < argumentsText.length; index += 11) {
            request.onFragment?.({
              argumentsText: argumentsText.slice(index, index + 11),
              callId: "call_write",
              index: 0,
              kind: "tool_call",
              name: "write_file"
            });
          }
          return {
            answer: "",
            continuationMessage: {
              role: "assistant",
              text: null,
              toolCalls: [{ argumentsText, callId: "call_write", index: 0, name: "write_file" }]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [{ argumentsText, callId: "call_write", index: 0, name: "write_file" }]
          };
        }
        request.onFragment?.({ kind: "answer", text: "创建完成" });
        return {
          answer: "创建完成",
          continuationMessage: { role: "assistant", text: "创建完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_mutation", title: "实时 diff" });
    store.append({ runId: "run_mutation", data: { model: "test", prompt: "创建 created.ts", startedAt: new Date().toISOString() }, sessionId: "session_mutation", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_mutation");
    await runAgent({ tools: eventToolHost, runId: "run_mutation", model: "test", projectRoot: directory, prompt: "创建 created.ts", provider, registry, sessionId: "session_mutation", signal: controller.signal, store });

    const events = store.readEvents("session_mutation");
    const mutationActivityId = events.find((event) => event.type === "activity.started" && (event.data as { tool?: { callId?: string } }).tool?.callId === "call_write")?.scope.activityId;
    const liveOffset = events.find((event) => event.scope.activityId === mutationActivityId && event.type === "activity.updated" && ((event.data as { liveFiles?: Array<{ additions: number }> }).liveFiles?.[0]?.additions ?? 0) > 0)?.offset ?? 0;
    const changesOffset = events.find((event) => event.type === "changes.changed" && ((event.data as { additions?: number }).additions ?? 0) > 0)?.offset ?? 0;
    const finishedOffset = events.find((event) => event.scope.activityId === mutationActivityId && event.type === "activity.finished")?.offset ?? 0;
    assert.ok(liveOffset > 0 && liveOffset < changesOffset, "streamed diff is visible before the filesystem result");
    assert.ok(changesOffset < finishedOffset, "authoritative diff is published while the activity is still running");

    const run = store.getRun("run_mutation")!;
    const mutation = run.activities.find((activity) => activity.activityId === mutationActivityId);
    assert.deepEqual(mutation?.liveFiles, []);
    assert.equal(mutation?.files?.[0]?.additions, 2);
    assert.equal(run.changes.additions, 2);
    assert.match(run.changes.files[0]?.patch ?? "", /\+export const two = 2/);
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("does not accept final content while a managed command is running", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-command-gate-"));
  const store = new RuntimeStore(directory);
  let commandChecks = 0;
  let correctionSeen = false;
  let stopCalls = 0;
  let turns = 0;
  const guardedToolHost = {
    ...toolHost,
    runningCommands: () => {
      commandChecks += 1;
      return turns === 1
      ? [{ commandId: "command_live", elapsedMs: 60_000 }]
      : [];
    },
    stopCommands: async () => { stopCalls += 1; }
  };
  const provider: Provider = {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream(request) {
      turns += 1;
      correctionSeen ||= request.messages.some((message) =>
        message.role === "user" && message.text?.includes("当前文本不能作为最终回答")
      );
      const answer = turns === 1 ? "命令已经可以了。" : "命令结束，检查完成。";
      request.onFragment?.({ kind: "answer", text: answer });
      return {
        answer,
        continuationMessage: { role: "assistant", text: answer },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };

  try {
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_command_gate",
      title: "命令门禁"
    });
    store.append({
      data: { model: "test", prompt: "检查状态", startedAt: new Date().toISOString() },
      runId: "run_command_gate",
      sessionId: "session_command_gate",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_command_gate");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "检查状态",
      provider,
      registry,
      runId: "run_command_gate",
      sessionId: "session_command_gate",
      signal: controller.signal,
      store,
      tools: guardedToolHost
    });

    assert.equal(turns, 2);
    assert.equal(correctionSeen, true);
    assert.equal(stopCalls, 1);
    assert.equal(store.getRun("run_command_gate")?.answer, "命令结束，检查完成。");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("command control calls update the original activity without creating a slot", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-command-control-"));
  const store = new RuntimeStore(directory);
  let turns = 0;
  const controlToolHost = {
    ...toolHost,
    execute: async (input: Parameters<typeof toolHost.execute>[0]) => input.name === "wait_command"
      ? {
          command: "node long.cjs",
          commandActivityId: "activity_original_command",
          commandId: "command_original",
          commandRunId: "run_command_control",
          commandSessionId: "session_command_control",
          commandState: "completed" as const,
          elapsedMs: 61_000,
          exitCode: 0,
          mutatedWorkspace: false,
          output: "finished",
          outputTruncated: false
        }
      : toolHost.execute(input),
    runningCommands: () => [],
    stopCommands: async () => undefined
  };
  const provider: Provider = {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream(request) {
      turns += 1;
      if (turns === 1) {
        const argumentsText = JSON.stringify({ commandId: "command_original" });
        request.onFragment?.({
          argumentsText,
          callId: "call_wait",
          index: 0,
          kind: "tool_call",
          name: "wait_command"
        });
        return {
          answer: "",
          continuationMessage: {
            role: "assistant",
            text: null,
            toolCalls: [{ argumentsText, callId: "call_wait", index: 0, name: "wait_command" }]
          },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: [{ argumentsText, callId: "call_wait", index: 0, name: "wait_command" }]
        };
      }
      request.onFragment?.({ kind: "answer", text: "命令已完成。" });
      return {
        answer: "命令已完成。",
        continuationMessage: { role: "assistant", text: "命令已完成。" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };

  try {
    store.createSession({
      accessMode: "full_access",
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_command_control",
      title: "命令控制"
    });
    store.append({
      data: { model: "test", prompt: "等待命令完成", startedAt: new Date().toISOString() },
      runId: "run_command_control",
      sessionId: "session_command_control",
      type: "run.started"
    });
    store.append({
      activityId: "activity_original_command",
      data: {
        audience: "user",
        command: { command: "node long.cjs", commandId: "command_original", state: "running" },
        kind: "command",
        startedAt: new Date().toISOString(),
        title: "运行命令"
      },
      runId: "run_command_control",
      sessionId: "session_command_control",
      type: "activity.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_command_control");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "等待命令完成",
      provider,
      registry,
      runId: "run_command_control",
      sessionId: "session_command_control",
      signal: controller.signal,
      store,
      tools: controlToolHost
    });

    const run = store.getRun("run_command_control")!;
    assert.equal(run.activities.find((activity) => activity.activityId === "activity_original_command")?.status, "completed");
    assert.equal(run.activities.some((activity) => activity.tool?.callId === "call_wait"), false);
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("an interrupted tool-call step is closed before the next conversation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-interrupted-step-"));
  const store = new RuntimeStore(directory);
  const calls = [
    { argumentsText: "{}", callId: "call_interrupted_a", index: 0, name: "list_files" },
    { argumentsText: "{}", callId: "call_interrupted_b", index: 1, name: "git_status" }
  ];
  try {
    store.createSession({
      accessMode: "full_access",
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_interrupted_step",
      title: "中断工具步骤"
    });
    store.append({
      data: { model: "test", prompt: "检查项目", startedAt: new Date().toISOString() },
      runId: "run_interrupted_step",
      sessionId: "session_interrupted_step",
      type: "run.started"
    });
    const firstRegistry = new RunRegistry();
    const firstController = firstRegistry.startRun("run_interrupted_step");
    const interruptedTools = {
      ...toolHost,
      parallel: (name: string) => {
        if (name === "tools_use_statement") return false;
        firstController.abort();
        throw new Error("scheduler interrupted");
      }
    };
    const firstProvider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream() {
        if (!store.readContextEntries("session_interrupted_step").some((entry) =>
          entry.kind === "tool_result" && entry.toolName === "tools_use_statement"
        )) {
          const declaration = {
            argumentsText: JSON.stringify({ mode: "new", title: "检查项目状态" }),
            callId: "call_interrupted_statement",
            index: 0,
            name: "tools_use_statement"
          };
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [declaration] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [declaration]
          };
        }
        return {
          answer: "",
          continuationMessage: { role: "assistant", text: null, toolCalls: calls },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: calls
        };
      }
    };
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "检查项目",
      provider: firstProvider,
      registry: firstRegistry,
      runId: "run_interrupted_step",
      sessionId: "session_interrupted_step",
      signal: firstController.signal,
      store,
      tools: interruptedTools
    });

    assert.equal(store.getRun("run_interrupted_step")?.status, "cancelled");
    assert.deepEqual(store.readContextEntries("session_interrupted_step")
      .filter((entry) => entry.kind === "tool_result")
      .map((entry) => entry.toolCallKey), ["call_interrupted_statement", "call_interrupted_a", "call_interrupted_b"]);

    store.append({
      data: { model: "test", prompt: "继续", startedAt: new Date().toISOString() },
      runId: "run_after_interruption",
      sessionId: "session_interrupted_step",
      type: "run.started"
    });
    let sawClosedProtocol = false;
    const secondProvider: Provider = {
      capabilities: firstProvider.capabilities,
      async stream(request) {
        const assistantIndex = request.messages.findIndex((message) =>
          message.role === "assistant" && message.toolCalls?.[0]?.callId === "call_interrupted_a"
        );
        assert.ok(assistantIndex >= 0);
        assert.deepEqual(request.messages.slice(assistantIndex + 1, assistantIndex + 3).map((message) => ({
          role: message.role,
          toolCallKey: message.toolCallKey
        })), [
          { role: "tool", toolCallKey: "call_interrupted_a" },
          { role: "tool", toolCallKey: "call_interrupted_b" }
        ]);
        sawClosedProtocol = true;
        return {
          answer: "已安全继续。",
          continuationMessage: { role: "assistant", text: "已安全继续。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const secondRegistry = new RunRegistry();
    const secondController = secondRegistry.startRun("run_after_interruption");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "继续",
      provider: secondProvider,
      registry: secondRegistry,
      runId: "run_after_interruption",
      sessionId: "session_interrupted_step",
      signal: secondController.signal,
      store,
      tools: toolHost
    });
    assert.equal(sawClosedProtocol, true);
    assert.equal(store.getRun("run_after_interruption")?.status, "completed");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
