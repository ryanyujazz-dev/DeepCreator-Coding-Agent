import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../server/app/runner";
import { TestRunRegistry as RunRegistry } from "./support/system";
import { Provider } from "../shared/contracts/provider";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";

test("applies a queued steer before accepting a terminal model response", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-run-steer-"));
  try {
    let turn = 0;
    const registry = new RunRegistry();
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
          assert.equal(registry.enqueueSteer("run_steer", { prompt: "请再检查测试", steerId: "follow_up_1" }), true);
          return {
            answer: "初步完成",
            continuationMessage: { role: "assistant", text: "初步完成" },
            finishCause: "complete",
            thinking: "",
            toolCalls: []
          };
        }
        assert.equal(request.messages.at(-1)?.role, "user");
        assert.equal(request.messages.at(-1)?.text, "请再检查测试");
        return {
          answer: "检查后完成",
          continuationMessage: { role: "assistant", text: "检查后完成" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_steer", title: "引导" });
    store.append({ runId: "run_steer", data: { model: "test", prompt: "检查实现", startedAt: new Date().toISOString() }, sessionId: "session_steer", type: "run.started" });
    const controller = registry.startRun("run_steer");

    await runAgent({ tools: toolHost, runId: "run_steer", model: "test", projectRoot: directory, prompt: "检查实现", provider, registry, sessionId: "session_steer", signal: controller.signal, store });

    assert.equal(turn, 2);
    assert.equal(store.getRun("run_steer")?.answer, "检查后完成");
    assert.ok(store.readContextEntries("session_steer").some((entry) =>
      entry.text === "请再检查测试" && entry.metadata?.steerId === "follow_up_1"
    ));
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("preempts an in-flight model request and continues with the steer as user input", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-run-steer-preempt-model-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
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
      if (turn === 1) {
        return new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
          const steerId = "follow_up_preempt_model";
          assert.equal(registry.enqueueSteer("run_steer_preempt_model", { prompt: "改为先检查测试", steerId }), true);
          store.appendContextEntry({
            kind: "human_text",
            metadata: { steerId },
            runId: "run_steer_preempt_model",
            sessionId: "session_steer_preempt_model",
            source: "user",
            text: "改为先检查测试"
          });
          assert.equal(registry.interruptForSteer("run_steer_preempt_model"), true);
        });
      }
      assert.equal(request.messages.at(-1)?.role, "user");
      assert.equal(request.messages.at(-1)?.text, "改为先检查测试");
      return {
        answer: "已按新要求检查测试",
        continuationMessage: { role: "assistant", text: "已按新要求检查测试" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };
  try {
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_steer_preempt_model", title: "即时引导" });
    store.append({ runId: "run_steer_preempt_model", data: { model: "test", prompt: "检查实现", startedAt: new Date().toISOString() }, sessionId: "session_steer_preempt_model", type: "run.started" });
    const controller = registry.startRun("run_steer_preempt_model");

    await runAgent({ tools: toolHost, runId: "run_steer_preempt_model", model: "test", projectRoot: directory, prompt: "检查实现", provider, registry, sessionId: "session_steer_preempt_model", signal: controller.signal, store });

    assert.equal(turn, 2);
    assert.equal(store.getRun("run_steer_preempt_model")?.status, "completed");
    assert.equal(store.getRun("run_steer_preempt_model")?.answer, "已按新要求检查测试");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("preempts a parallel tool step, closes every tool call, then applies the steer", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-run-steer-preempt-tools-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
  const calls = [
    { argumentsText: "{}", callId: "call_steer_tool_a", index: 0, name: "list_files" },
    { argumentsText: "{}", callId: "call_steer_tool_b", index: 1, name: "git_status" }
  ];
  let interrupted = false;
  let turn = 0;
  const interruptingTools = {
    ...toolHost,
    execute: async (input: Parameters<typeof toolHost.execute>[0]) => {
      if (!interrupted) {
        interrupted = true;
        const steerId = "follow_up_preempt_tools";
        assert.equal(registry.enqueueSteer("run_steer_preempt_tools", { prompt: "停止工具，改为总结现状", steerId }), true);
        store.appendContextEntry({
          kind: "human_text",
          metadata: { steerId },
          runId: "run_steer_preempt_tools",
          sessionId: "session_steer_preempt_tools",
          source: "user",
          text: "停止工具，改为总结现状"
        });
        assert.equal(registry.interruptForSteer("run_steer_preempt_tools"), true);
      }
      throw input.signal?.reason ?? new DOMException("工具步骤已中断", "AbortError");
    },
    parallel: () => true
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
        return {
          answer: "",
          continuationMessage: { role: "assistant", text: null, toolCalls: calls },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: calls
        };
      }
      const assistantIndex = request.messages.findIndex((message) =>
        message.role === "assistant" && message.toolCalls?.[0]?.callId === "call_steer_tool_a"
      );
      assert.ok(assistantIndex >= 0);
      assert.deepEqual(request.messages.slice(assistantIndex + 1, assistantIndex + 4).map((message) => ({
        role: message.role,
        toolCallKey: message.toolCallKey
      })), [
        { role: "tool", toolCallKey: "call_steer_tool_a" },
        { role: "tool", toolCallKey: "call_steer_tool_b" },
        { role: "user", toolCallKey: undefined }
      ]);
      assert.equal(request.messages.at(-1)?.text, "停止工具，改为总结现状");
      return {
        answer: "已停止原工具并总结现状",
        continuationMessage: { role: "assistant", text: "已停止原工具并总结现状" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };
  try {
    store.createSession({ accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_steer_preempt_tools", title: "工具中即时引导" });
    store.append({ runId: "run_steer_preempt_tools", data: { model: "test", prompt: "检查项目", startedAt: new Date().toISOString() }, sessionId: "session_steer_preempt_tools", type: "run.started" });
    const controller = registry.startRun("run_steer_preempt_tools");

    await runAgent({ tools: interruptingTools, runId: "run_steer_preempt_tools", model: "test", projectRoot: directory, prompt: "检查项目", provider, registry, sessionId: "session_steer_preempt_tools", signal: controller.signal, store });

    const results = store.readContextEntries("session_steer_preempt_tools").filter((entry) => entry.kind === "tool_result");
    assert.deepEqual(results.map((entry) => entry.toolCallKey), ["call_steer_tool_a", "call_steer_tool_b"]);
    assert.equal(store.getRun("run_steer_preempt_tools")?.answer, "已停止原工具并总结现状");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("preempts a tool waiting for approval and closes its call before continuing", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-run-steer-preempt-approval-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
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
      if (turn === 1) {
        const argumentsText = JSON.stringify({ path: "value.ts" });
        const call = { argumentsText, callId: "call_steer_approval", index: 0, name: "delete_file" };
        return {
          answer: "",
          continuationMessage: { role: "assistant", text: null, toolCalls: [call] },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: [call]
        };
      }
      const assistantIndex = request.messages.findIndex((message) =>
        message.role === "assistant" && message.toolCalls?.[0]?.callId === "call_steer_approval"
      );
      assert.ok(assistantIndex >= 0);
      assert.equal(request.messages[assistantIndex + 1]?.role, "tool");
      assert.equal(request.messages[assistantIndex + 1]?.toolCallKey, "call_steer_approval");
      assert.equal(request.messages[assistantIndex + 2]?.role, "user");
      assert.equal(request.messages[assistantIndex + 2]?.text, "不要写文件，先解释方案");
      return {
        answer: "已停止写入并改为说明方案",
        continuationMessage: { role: "assistant", text: "已停止写入并改为说明方案" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };
  try {
    writeFileSync(path.join(directory, "value.ts"), "export const value = 1;\n");
    store.createSession({ accessMode: "request_approval", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_steer_preempt_approval", title: "审批中即时引导" });
    store.append({ runId: "run_steer_preempt_approval", data: { model: "test", prompt: "写入文件", startedAt: new Date().toISOString() }, sessionId: "session_steer_preempt_approval", type: "run.started" });
    const unsubscribe = store.subscribe("session_steer_preempt_approval", (events) => {
      if (!events.some((event) => event.type === "approval.requested")) return;
      queueMicrotask(() => {
        const steerId = "follow_up_preempt_approval";
        assert.equal(registry.enqueueSteer("run_steer_preempt_approval", { prompt: "不要写文件，先解释方案", steerId }), true);
        store.appendContextEntry({
          kind: "human_text",
          metadata: { steerId },
          runId: "run_steer_preempt_approval",
          sessionId: "session_steer_preempt_approval",
          source: "user",
          text: "不要写文件，先解释方案"
        });
        assert.equal(registry.interruptForSteer("run_steer_preempt_approval"), true);
      });
    });
    const controller = registry.startRun("run_steer_preempt_approval");

    await runAgent({ tools: toolHost, runId: "run_steer_preempt_approval", model: "test", projectRoot: directory, prompt: "写入文件", provider, registry, sessionId: "session_steer_preempt_approval", signal: controller.signal, store });

    unsubscribe();
    assert.equal(existsSync(path.join(directory, "value.ts")), true);
    assert.equal(store.readContextEntries("session_steer_preempt_approval").filter((entry) =>
      entry.kind === "tool_result" && entry.toolCallKey === "call_steer_approval"
    ).length, 1);
    assert.equal(store.getRun("run_steer_preempt_approval")?.answer, "已停止写入并改为说明方案");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("persists a non-thinking reasoning summary before the Run finishes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-reasoning-summary-"));
  try {
    let summaryRequests = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        if (request.thinkingMode === "disabled") {
          summaryRequests += 1;
          assert.equal(request.model, "deepseek-v4-flash");
          assert.deepEqual(request.tools, []);
          const answer = '{"title":"核对页面跳转参数"}';
          return {
            answer,
            continuationMessage: { role: "assistant", text: answer },
            finishCause: "complete",
            thinking: "",
            toolCalls: []
          };
        }
        request.onFragment?.({ kind: "thinking", text: "先检查路由定义和页面接收参数。" });
        request.onFragment?.({ kind: "answer", text: "检查完成" });
        assert.equal(summaryRequests, 1, "the summary starts when thinking gives way to answer content");
        return {
          answer: "检查完成",
          continuationMessage: { role: "assistant", text: "检查完成" },
          finishCause: "complete",
          thinking: "先检查路由定义和页面接收参数。",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_summary", title: "思维摘要" });
    store.append({ runId: "run_summary", data: { model: "test", prompt: "检查页面", startedAt: new Date().toISOString() }, sessionId: "session_summary", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_summary");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "检查页面",
      provider,
      registry,
      runId: "run_summary",
      sessionId: "session_summary",
      signal: controller.signal,
      store,
      summaryModel: "deepseek-v4-flash",
      tools: toolHost
    });

    assert.equal(summaryRequests, 1);
    assert.equal(store.getRun("run_summary")?.reasoningTitle, "核对页面跳转参数");
    const events = store.readEvents("session_summary");
    const titleOffset = events.find((event) => event.type === "reasoning.title.updated")?.offset;
    const finishOffset = events.find((event) => event.type === "run.finished")?.offset;
    assert.ok(titleOffset && finishOffset && titleOffset < finishOffset);
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("recovers a transient provider failure before any stream fragment", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-runtime-"));
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

test("keeps model content user-visible when a protocol correction follows", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-visible-protocol-content-"));
  try {
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
        if (turn === 1) {
          request.onFragment?.({ kind: "answer", text: "未完整的模型输出" });
          return {
            answer: "未完整的模型输出",
            continuationMessage: { role: "assistant", text: "未完整的模型输出" },
            finishCause: "unknown",
            protocolIssue: {
              code: "incomplete_stream",
              message: "响应未完整结束。",
              retryable: true
            },
            thinking: "",
            toolCalls: []
          };
        }
        request.onFragment?.({ kind: "answer", text: "修正后的模型输出" });
        return {
          answer: "修正后的模型输出",
          continuationMessage: { role: "assistant", text: "修正后的模型输出" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_visible_protocol_content", title: "协议修正内容" });
    store.append({ runId: "run_visible_protocol_content", data: { model: "test", prompt: "输出内容", startedAt: new Date().toISOString() }, sessionId: "session_visible_protocol_content", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_visible_protocol_content");
    await runAgent({ tools: toolHost, runId: "run_visible_protocol_content", model: "test", projectRoot: directory, prompt: "输出内容", provider, registry, sessionId: "session_visible_protocol_content", signal: controller.signal, store });

    const messages = store.getRun("run_visible_protocol_content")!.activities.filter((activity) => activity.kind === "message");
    assert.equal(turn, 2);
    assert.deepEqual(messages.map((activity) => [activity.body, activity.audience, activity.status]), [
      ["未完整的模型输出", "user", "failed"],
      ["修正后的模型输出", "user", "completed"]
    ]);
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("rejects incomplete task updates without replacing readable labels", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-complete-task-labels-"));
  try {
    let turn = 0;
    let sawMissingLabelError = false;
    const store = new RuntimeStore(directory);
    const initialTaskCall = {
      argumentsText: JSON.stringify({
        tasks: [
          { label: "读取现有实现", status: "running", taskId: "h1" },
          { label: "完成修改并验证", status: "pending", taskId: "h2" }
        ]
      }),
      callId: "call_tasks_with_labels",
      index: 0,
      name: "update_tasks"
    };
    const incompleteTaskCall = {
      argumentsText: JSON.stringify({
        tasks: [
          { status: "completed", taskId: "h1" },
          { status: "running", taskId: "h2" }
        ]
      }),
      callId: "call_tasks_without_labels",
      index: 0,
      name: "update_tasks"
    };
    const correctedTaskCall = {
      argumentsText: JSON.stringify({
        tasks: [
          { label: "读取现有实现", status: "completed", taskId: "h1" },
          { label: "完成修改并验证", status: "completed", taskId: "h2" }
        ]
      }),
      callId: "call_tasks_corrected",
      index: 0,
      name: "update_tasks"
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
        const toolCall = turn === 1 ? initialTaskCall : turn === 2 ? incompleteTaskCall : turn === 3 ? correctedTaskCall : undefined;
        if (toolCall) {
          if (turn === 3) {
            sawMissingLabelError = request.messages.some((message) => message.role === "tool" && message.text?.includes("缺少必填参数 label"));
            assert.deepEqual(store.getRun("run_complete_task_labels")?.tasks, [
              { label: "读取现有实现", status: "running", taskId: "h1" },
              { label: "完成修改并验证", status: "pending", taskId: "h2" }
            ]);
          }
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [toolCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [toolCall]
          };
        }
        request.onFragment?.({ kind: "answer", text: "任务完成。" });
        return {
          answer: "任务完成。",
          continuationMessage: { role: "assistant", text: "任务完成。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_complete_task_labels", title: "完整任务描述" });
    store.append({ runId: "run_complete_task_labels", data: { model: "test", prompt: "执行任务", startedAt: new Date().toISOString() }, sessionId: "session_complete_task_labels", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_complete_task_labels");
    await runAgent({ tools: toolHost, runId: "run_complete_task_labels", model: "test", projectRoot: directory, prompt: "执行任务", provider, registry, sessionId: "session_complete_task_labels", signal: controller.signal, store });

    assert.equal(turn, 4);
    assert.equal(sawMissingLabelError, true);
    assert.deepEqual(store.getRun("run_complete_task_labels")?.tasks, [
      { label: "读取现有实现", status: "completed", taskId: "h1" },
      { label: "完成修改并验证", status: "completed", taskId: "h2" }
    ]);
    assert.equal(store.readEvents("session_complete_task_labels").filter((event) => event.type === "tasks.changed").length, 2);
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("flushes short content before a following tool call finishes streaming", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-content-boundary-"));
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
        if (turn === 1) {
          request.onFragment?.({ kind: "answer", text: "先读取" });
          request.onFragment?.({ kind: "answer", text: "配置文件。" });
          request.onFragment?.({
            argumentsText: "{\"path\":",
            callId: "call_content_boundary",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          const message = store.getRun("run_content_boundary")?.activities
            .find((activity) => activity.kind === "message");
          assert.equal(message?.body, "先读取配置文件。");
          request.onFragment?.({
            argumentsText: "\"sample.ts\"}",
            callId: "call_content_boundary",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          const toolCall = {
            argumentsText: "{\"path\":\"sample.ts\"}",
            callId: "call_content_boundary",
            index: 0,
            name: "read_file"
          };
          return {
            answer: "先读取配置文件。",
            continuationMessage: { role: "assistant", text: "先读取配置文件。", toolCalls: [toolCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [toolCall]
          };
        }
        request.onFragment?.({ kind: "answer", text: "完成。" });
        return {
          answer: "完成。",
          continuationMessage: { role: "assistant", text: "完成。" },
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
      sessionId: "session_content_boundary",
      title: "内容边界"
    });
    store.append({
      data: { model: "test", prompt: "读取配置", startedAt: new Date().toISOString() },
      runId: "run_content_boundary",
      sessionId: "session_content_boundary",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_content_boundary");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "读取配置",
      provider,
      registry,
      runId: "run_content_boundary",
      sessionId: "session_content_boundary",
      signal: controller.signal,
      store,
      tools: toolHost
    });
    assert.equal(store.getRun("run_content_boundary")?.status, "completed");
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("flushes short content after a bounded delay while the provider remains open", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-content-latency-"));
  try {
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        request.onFragment?.({ kind: "answer", text: "短" });
        request.onFragment?.({ kind: "answer", text: "内容" });
        await new Promise((resolve) => setTimeout(resolve, 70));
        const message = store.getRun("run_content_latency")?.activities
          .find((activity) => activity.kind === "message");
        assert.equal(message?.body, "短内容");
        return {
          answer: "短内容",
          continuationMessage: { role: "assistant", text: "短内容" },
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
      sessionId: "session_content_latency",
      title: "内容延迟"
    });
    store.append({
      data: { model: "test", prompt: "输出短内容", startedAt: new Date().toISOString() },
      runId: "run_content_latency",
      sessionId: "session_content_latency",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_content_latency");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "输出短内容",
      provider,
      registry,
      runId: "run_content_latency",
      sessionId: "session_content_latency",
      signal: controller.signal,
      store,
      tools: toolHost
    });
    assert.equal(store.getRun("run_content_latency")?.status, "completed");
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("persists semantic tool facts while provider schemas stay presentation-free", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-runtime-tool-"));
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
          request.onFragment?.({
            argumentsText: "{\"path\":\"sample.ts\"}",
            callId: "call_read",
            index: 0,
            kind: "tool_call",
            name: "read_file"
          });
          // 新设计:tool_call name 识别即预开 activity(phase generating_args),fragment 后该 activity 已存在。
          assert.equal(store.getRun("run_tool")?.activities.some((activity) => activity.tool?.callId === "call_read"), true);
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
    assert.equal(readUnit?.tool?.callIndex, 0);
    assert.equal(readUnit?.tool?.stepHeadline, "read");
    assert.ok(readUnit?.tool?.modelStepId.startsWith("model_step_"));
    const events = store.readEvents("session_tool");
    // 新设计:工具 name 识别预开 + arguments delta + phase 翻转都会发 activity.updated(read_file 此用例
    // 的 fragment 带全量 argumentsText → arguments delta updated;pipeline.run 复用分支 → phase=executing updated)。
    // 不再断言"无 updated";下面遍历仍保证 started/updated/finished 都不含 title、tool 不含 legacy 字段。
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

test("retains started ToolState when tool execution fails", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-runtime-tool-failure-"));
  try {
    let turn = 0;
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream() {
        turn += 1;
        if (turn === 1) {
          const toolCalls = [{
            argumentsText: "{\"path\":\"missing.ts\"}",
            callId: "call_missing_read",
            index: 0,
            name: "read_file"
          }];
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls
          };
        }
        return {
          answer: "文件不存在。",
          continuationMessage: { role: "assistant", text: "文件不存在。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_tool_failure", title: "工具失败" });
    store.append({ runId: "run_tool_failure", data: { model: "test", prompt: "读取缺失文件", startedAt: new Date().toISOString() }, sessionId: "session_tool_failure", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_tool_failure");
    await runAgent({ tools: toolHost, runId: "run_tool_failure", model: "test", projectRoot: directory, prompt: "读取缺失文件", provider, registry, sessionId: "session_tool_failure", signal: controller.signal, store });

    const failed = store.getRun("run_tool_failure")?.activities.find((activity) => activity.tool?.callId === "call_missing_read");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.tool?.toolName, "read_file");
    assert.equal(failed?.tool?.action, "inspect");
    assert.equal(failed?.tool?.normalizedTarget, "missing.ts");
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("buffers mutation arguments and publishes only authoritative file diffs before settlement", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-runtime-mutation-"));
  try {
    const eventToolHost = {
      ...toolHost,
      capture: async () => ({
        available: true,
        files: new Map(),
        leases: 1,
        released: false,
        snapshotDirectory: path.join(directory, "unused-baseline")
      }),
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
    assert.equal(liveOffset, 0, "provider argument fragments stay out of the public activity stream");
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

test("keeps a Responses apply_patch draft separate from Git-derived file facts", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-responses-patch-"));
  try {
    const patch = "*** Begin Patch\n*** Add File: patched.ts\n+export const patched = true;\n*** End Patch";
    const responsesToolHost = {
      ...toolHost,
      capture: async () => ({
        available: true,
        files: new Map(),
        leases: 1,
        released: false,
        snapshotDirectory: path.join(directory, "unused-baseline")
      }),
      changes: async () => existsSync(path.join(directory, "patched.ts")) ? {
        additions: 1,
        comparisonBase: "run_start" as const,
        deletions: 0,
        fileCount: 1,
        files: [{
          additions: 1,
          deletions: 0,
          operation: "created" as const,
          patch: "diff --git a/patched.ts b/patched.ts\n--- /dev/null\n+++ b/patched.ts\n@@ -0,0 +1 @@\n+export const patched = true;",
          path: "patched.ts"
        }]
      } : { additions: 0, comparisonBase: "run_start" as const, deletions: 0, fileCount: 0, files: [] },
      checkpoint: async () => undefined,
      close: async () => undefined
    };
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
        if (turn === 1) {
          const stepId = request.modelStepId!;
          request.onFragment?.({
            item: { callId: "patch_call", draft: patch, itemId: "patch_item", outputIndex: 0, sequence: 1, status: "generating", toolName: "apply_patch", type: "custom" },
            kind: "output_item"
          });
          request.onFragment?.({
            item: { callId: "patch_call", draft: patch, itemId: "patch_item", outputIndex: 0, sequence: 2, status: "completed", toolName: "apply_patch", type: "custom" },
            kind: "output_item"
          });
          return {
            answer: "",
            continuationMessage: {
              outputItems: [{ callId: "patch_call", draft: patch, itemId: "patch_item", modelStepId: stepId, outputIndex: 0, sequence: 2, status: "completed", toolName: "apply_patch", type: "custom" }],
              role: "assistant",
              text: null,
              toolCalls: [{ argumentsText: JSON.stringify({ patch }), callId: "patch_call", index: 0, name: "apply_patch" }]
            },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [{ argumentsText: JSON.stringify({ patch }), callId: "patch_call", index: 0, name: "apply_patch" }]
          };
        }
        request.onFragment?.({ kind: "answer", text: "补丁已应用。" });
        return {
          answer: "补丁已应用。",
          continuationMessage: { role: "assistant", text: "补丁已应用。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const store = new RuntimeStore(directory);
    store.createSession({ accessMode: "full_access", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "deepseek-v4-flash", projectRoot: directory, sessionId: "session_responses_patch", title: "Responses patch" });
    store.append({ runId: "run_responses_patch", data: { model: "deepseek-v4-flash", prompt: "应用补丁", protocol: "responses", startedAt: new Date().toISOString() }, sessionId: "session_responses_patch", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_responses_patch");
    await runAgent({ tools: responsesToolHost, runId: "run_responses_patch", model: "deepseek-v4-flash", projectRoot: directory, prompt: "应用补丁", protocol: "responses", provider, registry, sessionId: "session_responses_patch", signal: controller.signal, store });

    const events = store.readEvents("session_responses_patch");
    const patchActivityId = events.find((event) => event.type === "activity.started" && (event.data as { modelItemId?: string }).modelItemId === "patch_item")?.scope.activityId;
    const draftOffset = events.find((event) => event.scope.activityId === patchActivityId && event.type === "activity.updated" && (event.data as { draft?: { state?: string } }).draft?.state === "unapplied")?.offset ?? 0;
    const changesOffset = events.find((event) => event.type === "changes.changed" && ((event.data as { additions?: number }).additions ?? 0) > 0)?.offset ?? 0;
    const finishedOffset = events.find((event) => event.scope.activityId === patchActivityId && event.type === "activity.finished")?.offset ?? 0;
    assert.ok(draftOffset > 0 && draftOffset < changesOffset);
    assert.ok(changesOffset < finishedOffset);
    const activity = store.getRun("run_responses_patch")?.activities.find((candidate) => candidate.activityId === patchActivityId);
    assert.equal(activity?.draft?.state, "applied");
    assert.equal(activity?.liveFiles?.length ?? 0, 0);
    assert.equal(activity?.files?.[0]?.path, "patched.ts");
    assert.equal(store.getRun("run_responses_patch")?.changes.files[0]?.path, "patched.ts");
    store.close();
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("publishes a Chat apply_patch draft before requesting approval", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-chat-patch-approval-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
  const patch = "*** Begin Patch\n*** Add File: approved.ts\n+export const approved = true;\n*** End Patch";
  let turn = 0;
  let observedDraft = false;
  const provider: Provider = {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream() {
      turn += 1;
      if (turn === 1) {
        const call = { argumentsText: JSON.stringify({ patch }), callId: "chat_patch_call", index: 0, name: "apply_patch" };
        return {
          answer: "",
          continuationMessage: { role: "assistant", text: null, toolCalls: [call] },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: [call]
        };
      }
      return {
        answer: "补丁未获批准。",
        continuationMessage: { role: "assistant", text: "补丁未获批准。" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }
  };
  try {
    store.createSession({ accessMode: "request_approval", compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "test", projectRoot: directory, sessionId: "session_chat_patch", title: "Chat patch" });
    store.append({ runId: "run_chat_patch", data: { model: "test", prompt: "应用补丁", protocol: "chat", startedAt: new Date().toISOString() }, sessionId: "session_chat_patch", type: "run.started" });
    const unsubscribe = store.subscribe("session_chat_patch", (events) => {
      const requested = events.find((event) => event.type === "approval.requested");
      if (!requested) return;
      const activity = store.getRun("run_chat_patch")?.activities.find((candidate) => candidate.tool?.callId === "chat_patch_call");
      observedDraft = activity?.draft?.state === "waiting_approval" && activity.draft.text === patch;
      queueMicrotask(() => registry.resolveApproval({
        approvalId: (requested.data as { approvalId: string }).approvalId,
        decision: "deny",
        store
      }));
    });
    const controller = registry.startRun("run_chat_patch");
    await runAgent({ tools: toolHost, runId: "run_chat_patch", model: "test", projectRoot: directory, prompt: "应用补丁", protocol: "chat", provider, registry, sessionId: "session_chat_patch", signal: controller.signal, store });
    unsubscribe();
    assert.equal(observedDraft, true);
    assert.equal(existsSync(path.join(directory, "approved.ts")), false);
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

test("does not accept final content while a managed command is running", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-command-gate-"));
  const store = new RuntimeStore(directory);
  let commandChecks = 0;
  let correctionSeen = false;
  let stopCalls = 0;
  let turns = 0;
  const guardedToolHost = {
    ...toolHost,
    runningCommands: () => commandChecks++ === 0
      ? [{ commandId: "command_live", elapsedMs: 60_000 }]
      : [],
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
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-command-control-"));
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

test("command settlement is idempotent when callback and return path observe the same terminal state", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-command-settlement-race-"));
  const store = new RuntimeStore(directory);
  let turns = 0;
  const racingToolHost = {
    ...toolHost,
    execute: async (input: Parameters<typeof toolHost.execute>[0]) => {
      if (input.name !== "run_command") return toolHost.execute(input);
      const result = {
        command: "printf done",
        commandId: "command_settlement_race",
        commandState: "completed" as const,
        elapsedMs: 1,
        exitCode: 0,
        mutatedWorkspace: false,
        output: "done",
        outputTruncated: false
      };
      input.onCommandSettled?.(result);
      return result;
    },
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
        const argumentsText = JSON.stringify({ command: "printf done" });
        request.onFragment?.({
          argumentsText,
          callId: "call_settlement_race",
          index: 0,
          kind: "tool_call",
          name: "run_command"
        });
        return {
          answer: "",
          continuationMessage: {
            role: "assistant",
            text: null,
            toolCalls: [{ argumentsText, callId: "call_settlement_race", index: 0, name: "run_command" }]
          },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: [{ argumentsText, callId: "call_settlement_race", index: 0, name: "run_command" }]
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
      sessionId: "session_settlement_race",
      title: "命令结算竞态"
    });
    store.append({
      data: { model: "test", prompt: "运行命令", startedAt: new Date().toISOString() },
      runId: "run_settlement_race",
      sessionId: "session_settlement_race",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_settlement_race");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "运行命令",
      provider,
      registry,
      runId: "run_settlement_race",
      sessionId: "session_settlement_race",
      signal: controller.signal,
      store,
      tools: racingToolHost
    });

    const run = store.getRun("run_settlement_race")!;
    const commandActivity = run.activities.find((activity) => activity.tool?.callId === "call_settlement_race");
    const finishEvents = store.readEvents("session_settlement_race").filter((event) =>
      event.type === "activity.finished" && event.scope.activityId === commandActivity?.activityId
    );
    assert.equal(run.status, "completed");
    assert.equal(run.answer, "命令已完成。");
    assert.equal(commandActivity?.status, "completed");
    assert.equal(finishEvents.length, 1);
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("Skill script commands stream output and settle through the managed command lifecycle", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-command-pipeline-"));
  const store = new RuntimeStore(directory);
  let turns = 0;
  const managedSkillTools = {
    ...toolHost,
    execute: async (input: Parameters<typeof toolHost.execute>[0]) => {
      if (input.name !== "run_skill_script") return toolHost.execute(input);
      assert.equal(typeof input.onOutput, "function");
      assert.equal(typeof input.onCommandSettled, "function");
      const running = {
        command: "node trusted-skill.mjs",
        commandId: "command_skill_pipeline",
        commandState: "running" as const,
        elapsedMs: 20,
        mutatedWorkspace: false,
        output: "started",
        outputTruncated: false
      };
      setTimeout(() => {
        input.onOutput?.({ text: "finished" });
        input.onCommandSettled?.({
          ...running,
          commandState: "completed",
          elapsedMs: 30,
          exitCode: 0,
          output: "started\nfinished"
        });
      }, 0);
      return running;
    },
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
        const argumentsText = JSON.stringify({ capabilityId: "skill:test:0123456789ab", scriptId: "validate" });
        request.onFragment?.({
          argumentsText,
          callId: "call_skill_pipeline",
          index: 0,
          kind: "tool_call",
          name: "run_skill_script"
        });
        return {
          answer: "",
          continuationMessage: {
            role: "assistant",
            text: null,
            toolCalls: [{ argumentsText, callId: "call_skill_pipeline", index: 0, name: "run_skill_script" }]
          },
          finishCause: "tool_calls",
          thinking: "",
          toolCalls: [{ argumentsText, callId: "call_skill_pipeline", index: 0, name: "run_skill_script" }]
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      request.onFragment?.({ kind: "answer", text: "Skill 脚本已完成。" });
      return {
        answer: "Skill 脚本已完成。",
        continuationMessage: { role: "assistant", text: "Skill 脚本已完成。" },
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
      sessionId: "session_skill_pipeline",
      title: "Skill command pipeline"
    });
    store.append({
      data: { model: "test", prompt: "运行 Skill 脚本", startedAt: new Date().toISOString() },
      runId: "run_skill_pipeline",
      sessionId: "session_skill_pipeline",
      type: "run.started"
    });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_skill_pipeline");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "运行 Skill 脚本",
      provider,
      registry,
      runId: "run_skill_pipeline",
      sessionId: "session_skill_pipeline",
      signal: controller.signal,
      store,
      tools: managedSkillTools
    });

    const activity = store.getRun("run_skill_pipeline")?.activities.find((item) => item.tool?.callId === "call_skill_pipeline");
    assert.equal(activity?.status, "completed");
    assert.equal(activity?.command?.state, "completed");
    assert.match(activity?.body ?? "", /finished/);
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("an interrupted tool-call step is closed before the next conversation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-interrupted-step-"));
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
      parallel: () => {
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
      .map((entry) => entry.toolCallKey), ["call_interrupted_a", "call_interrupted_b"]);

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

test("requires final task maintenance after the last work tool before accepting a final answer", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-final-task-maintenance-"));
  const store = new RuntimeStore(directory);
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_final_task_maintenance",
      title: "最终任务维护"
    });
    store.append({
      data: { model: "test", prompt: "检查 sample.ts", startedAt: new Date().toISOString() },
      runId: "run_final_task_maintenance",
      sessionId: "session_final_task_maintenance",
      type: "run.started"
    });

    const initialTaskCall = {
      argumentsText: JSON.stringify({
        tasks: [{ taskId: "t1", label: "检查 sample.ts", status: "completed" }]
      }),
      callId: "call_tasks_initial",
      index: 0,
      name: "update_tasks"
    };
    const readCall = {
      argumentsText: JSON.stringify({ path: "sample.ts" }),
      callId: "call_read_after_tasks",
      index: 0,
      name: "read_file"
    };
    const finalTaskCall = {
      argumentsText: JSON.stringify({
        tasks: [{ taskId: "t1", label: "检查 sample.ts", status: "completed" }]
      }),
      callId: "call_tasks_final",
      index: 0,
      name: "update_tasks"
    };
    let turn = 0;
    let sawMaintenanceCorrection = false;
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
          request.onFragment?.({ kind: "answer", text: "任务已经全部完成。" });
          return {
            answer: "任务已经全部完成。",
            continuationMessage: { role: "assistant", text: "任务已经全部完成。", toolCalls: [initialTaskCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [initialTaskCall]
          };
        }
        if (turn === 2) {
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [readCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [readCall]
          };
        }
        if (turn === 3) {
          request.onFragment?.({ kind: "answer", text: "过早的最终回答。" });
          return {
            answer: "过早的最终回答。",
            continuationMessage: { role: "assistant", text: "过早的最终回答。" },
            finishCause: "complete",
            thinking: "",
            toolCalls: []
          };
        }
        if (turn === 4) {
          sawMaintenanceCorrection = request.messages.some((message) =>
            message.role === "user" && message.text?.includes("任务计划尚未完成收尾")
          );
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [finalTaskCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [finalTaskCall]
          };
        }
        request.onFragment?.({ kind: "answer", text: "最终回答。" });
        return {
          answer: "最终回答。",
          continuationMessage: { role: "assistant", text: "最终回答。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const registry = new RunRegistry();
    const controller = registry.startRun("run_final_task_maintenance");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "检查 sample.ts",
      provider,
      registry,
      runId: "run_final_task_maintenance",
      sessionId: "session_final_task_maintenance",
      signal: controller.signal,
      store,
      tools: toolHost
    });

    const run = store.getRun("run_final_task_maintenance")!;
    assert.equal(turn, 5);
    assert.equal(sawMaintenanceCorrection, true);
    assert.equal(run.status, "completed");
    assert.equal(run.answer, "最终回答。");
    assert.deepEqual(run.tasks.map((task) => task.status), ["completed"]);
    assert.equal(run.activities.filter((activity) => activity.tool).at(-1)?.tool?.toolName, "update_tasks");
    assert.equal(run.activities.find((activity) => activity.body === "任务已经全部完成。")?.audience, "user");
    assert.equal(run.activities.find((activity) => activity.body === "过早的最终回答。")?.audience, "user");
    assert.equal(run.activities.find((activity) => activity.body === "最终回答。")?.audience, "user");
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("allows update_tasks to share one tool_calls batch with work tools", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-batched-task-update-"));
  const store = new RuntimeStore(directory);
  try {
    writeFileSync(path.join(directory, "sample.ts"), "export const sample = true;\n");
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_batched_task_update",
      title: "任务更新同批调用"
    });
    store.append({
      data: { model: "test", prompt: "检查 sample.ts", startedAt: new Date().toISOString() },
      runId: "run_batched_task_update",
      sessionId: "session_batched_task_update",
      type: "run.started"
    });

    const calls = [{
      argumentsText: JSON.stringify({ path: "sample.ts" }),
      callId: "call_batched_read",
      index: 0,
      name: "read_file"
    }, {
      argumentsText: JSON.stringify({
        tasks: [{ taskId: "t1", label: "检查 sample.ts", status: "completed" }]
      }),
      callId: "call_batched_tasks",
      index: 1,
      name: "update_tasks"
    }];
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
        if (turn === 1) {
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: calls },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: calls
          };
        }
        assert.deepEqual(
          request.messages.filter((message) => message.role === "tool").map((message) => message.toolCallKey),
          ["call_batched_read", "call_batched_tasks"]
        );
        return {
          answer: "检查完成。",
          continuationMessage: { role: "assistant", text: "检查完成。" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    const registry = new RunRegistry();
    const controller = registry.startRun("run_batched_task_update");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "检查 sample.ts",
      provider,
      registry,
      runId: "run_batched_task_update",
      sessionId: "session_batched_task_update",
      signal: controller.signal,
      store,
      tools: toolHost
    });

    const run = store.getRun("run_batched_task_update")!;
    const activities = run.activities.filter((activity) =>
      activity.tool?.callId === "call_batched_read" || activity.tool?.callId === "call_batched_tasks"
    );
    assert.equal(turn, 2);
    assert.equal(run.status, "completed");
    assert.equal(run.answer, "检查完成。");
    assert.deepEqual(run.tasks, [{ taskId: "t1", label: "检查 sample.ts", status: "completed" }]);
    assert.deepEqual(activities.map((activity) => activity.status), ["completed", "completed"]);
    assert.equal(new Set(activities.map((activity) => activity.tool?.modelStepId)).size, 1);
  } finally {
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
