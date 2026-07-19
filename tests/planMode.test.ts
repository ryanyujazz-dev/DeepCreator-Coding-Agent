import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { answerQuestion, resolvePlan } from "../server/app/planReview";
import { RunRegistry } from "../server/app/runRegistry";
import { runAgent } from "../server/app/runner";
import { analyzeCommand } from "../server/domain/accessPolicy";
import { hasConflictingControlStep, planPolicy } from "../server/domain/planPolicy";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";
import { Provider, ToolCall } from "../shared/contracts/provider";
import { ToolState } from "../shared/contracts/runtime";

function tool(name: string, args: Record<string, unknown>, index = 0): ToolState {
  return toolHost.prepare({
    args,
    argumentsPreview: toolHost.summarizeArgs(name, args),
    callId: `call_${name}_${index}`,
    modelStepId: "step_test",
    name,
    projectRoot: "/tmp/project"
  });
}

function providerFor(responses: Array<{ answer?: string; call?: ToolCall }>): Provider {
  let cursor = 0;
  return {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream(request) {
      const response = responses[cursor++];
      if (!response) throw new Error("Unexpected provider request.");
      if (response.call) {
        request.onFragment?.({
          argumentsText: response.call.argumentsText,
          callId: response.call.callId,
          index: response.call.index,
          kind: "tool_call",
          name: response.call.name
        });
        return {
          answer: "",
          continuationMessage: { role: "assistant", text: null, toolCalls: [response.call] },
          finishCause: "tool_calls" as const,
          thinking: "",
          toolCalls: [response.call]
        };
      }
      request.onFragment?.({ kind: "answer", text: response.answer ?? "" });
      return {
        answer: response.answer ?? "",
        continuationMessage: { role: "assistant", text: response.answer ?? "" },
        finishCause: "complete" as const,
        thinking: "",
        toolCalls: []
      };
    }
  };
}

function fragmentedPlanProvider(call: ToolCall, fragmentSize = 7): Provider {
  return {
    capabilities: {
      contextWindowTokens: 1_000_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    async stream(request) {
      for (let offset = 0; offset < call.argumentsText.length; offset += fragmentSize) {
        request.onFragment?.({
          argumentsText: call.argumentsText.slice(offset, offset + fragmentSize),
          callId: call.callId,
          index: call.index,
          kind: "tool_call",
          name: call.name
        });
      }
      return {
        answer: "",
        continuationMessage: { role: "assistant", text: null, toolCalls: [call] },
        finishCause: "tool_calls" as const,
        thinking: "",
        toolCalls: [call]
      };
    }
  };
}

test("PlanPolicy is authoritative and only permits narrowly read-only exploration", () => {
  assert.equal(analyzeCommand("git status --short").planSafe, true);
  assert.equal(analyzeCommand("sed -n '1,80p' src/App.tsx").planSafe, true);
  assert.equal(analyzeCommand("npm test").planSafe, false);
  assert.equal(analyzeCommand("cat package.json | head").planSafe, false);
  assert.equal(analyzeCommand("cat ../secret.txt").planSafe, false);
  assert.equal(analyzeCommand("curl https://example.com").planSafe, false);

  assert.equal(planPolicy({ args: { path: "src/App.tsx", content: "x" }, mode: "plan", planEntry: "auto", tool: tool("write_file", { path: "src/App.tsx", content: "x" }) }).allowed, false);
  assert.equal(planPolicy({ args: { command: "git status --short" }, mode: "plan", planEntry: "auto", tool: tool("run_command", { command: "git status --short" }) }).allowed, true);
  assert.equal(planPolicy({ args: { command: "npm test" }, mode: "plan", planEntry: "auto", tool: tool("run_command", { command: "npm test" }) }).allowed, false);
  assert.equal(planPolicy({ args: {}, mode: "work", planEntry: "manual", tool: tool("enter_plan", {}) }).allowed, false);
  assert.equal(hasConflictingControlStep([tool("enter_plan", {}), tool("write_file", { path: "a", content: "b" }, 1)]), true);
});

test("RunRegistry defers an early review continuation until the suspended stack exits", () => {
  const registry = new RunRegistry();
  const calls: string[] = [];
  registry.startRun("run_race");
  registry.afterRun("run_race", () => calls.push("resume"));
  assert.deepEqual(calls, []);
  registry.finishRun("run_race");
  assert.deepEqual(calls, ["resume"]);

  registry.afterRun("run_settled", () => calls.push("immediate"));
  assert.deepEqual(calls, ["resume", "immediate"]);
});

test("RunRegistry aborts and drains active runs during Runtime shutdown", async () => {
  const registry = new RunRegistry();
  const controller = registry.startRun("run_shutdown");
  controller.signal.addEventListener("abort", () => registry.finishRun("run_shutdown"), { once: true });

  await registry.cancelAllAndWait();

  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.hasRun("run_shutdown"), false);
});

test("submit_plan suspends durably and approval resumes the same Run with a paired tool result", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-plan-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      mode: "plan",
      model: "test",
      planEntry: "suggest",
      projectRoot: directory,
      sessionId: "session_plan",
      title: "计划测试"
    });
    store.append({
      data: { mode: "plan", model: "test", prompt: "先制定方案", startedAt: new Date().toISOString() },
      runId: "run_plan",
      sessionId: "session_plan",
      type: "run.started"
    });
    const submitCall: ToolCall = {
      argumentsText: JSON.stringify({ title: "实现计划模式", markdown: "## 目标\n\n1. 完成 Runtime\n2. 完成前端" }),
      callId: "call_submit_plan",
      index: 0,
      name: "submit_plan"
    };
    const registry = new RunRegistry();
    const firstController = registry.startRun("run_plan");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "先制定方案",
      provider: providerFor([{ call: submitCall }]),
      registry,
      runId: "run_plan",
      sessionId: "session_plan",
      signal: firstController.signal,
      store,
      tools: toolHost
    });
    registry.finishRun("run_plan");

    let session = store.getSession("session_plan")!;
    assert.equal(session.runs[0].status, "waiting");
    assert.equal(session.plans.length, 1);
    assert.equal(session.plans[0].status, "proposed");
    assert.equal(store.readContextEntries("session_plan").some((entry) => entry.toolCallKey === submitCall.callId && entry.kind === "tool_result"), false);

    store.close();
    const restored = new RuntimeStore(directory);
    session = restored.getSession("session_plan")!;
    assert.equal(session.runs[0].status, "waiting", "a proposed Plan survives Runtime restart");
    assert.equal(session.plans[0].markdown.includes("Runtime"), true);

    const review = resolvePlan({
      accessMode: "smart_approval",
      decision: "start_work",
      planId: session.plans[0].planId,
      revision: session.plans[0].revision,
      sessionId: session.sessionId,
      store: restored
    });
    assert.equal(review.resume?.runId, "run_plan");
    assert.equal(review.session.mode, "work");
    assert.equal(review.session.runs[0].status, "running");

    const records = restored.readContextEntries("session_plan");
    const submitMessage = records.find((entry) => entry.toolCalls?.some((call) => call.callId === submitCall.callId));
    const submitResult = records.find((entry) => entry.toolCallKey === submitCall.callId && entry.toolName === "submit_plan");
    assert.ok(submitMessage);
    assert.ok(submitResult);
    assert.equal(JSON.parse(submitResult.text ?? "{}").decision, "start_work");

    const secondRegistry = new RunRegistry();
    const secondController = secondRegistry.startRun("run_plan");
    await runAgent({
      continuation: true,
      model: "test",
      projectRoot: directory,
      prompt: "先制定方案",
      provider: providerFor([{ answer: "已根据批准的方案完成当前工作。" }]),
      registry: secondRegistry,
      runId: "run_plan",
      sessionId: "session_plan",
      signal: secondController.signal,
      store: restored,
      tools: toolHost
    });
    assert.equal(restored.getRun("run_plan")?.status, "completed");
    assert.equal(restored.getRun("run_plan")?.answer, "已根据批准的方案完成当前工作。");
    restored.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fragmented submit_plan emits semantic Plan activity updates without exposing raw arguments", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-plan-stream-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      mode: "plan",
      model: "test",
      projectRoot: directory,
      sessionId: "session_plan_stream",
      title: "流式计划"
    });
    store.append({
      data: { mode: "plan", model: "test", prompt: "制定方案", startedAt: new Date().toISOString() },
      runId: "run_plan_stream",
      sessionId: "session_plan_stream",
      type: "run.started"
    });
    const markdown = "## 目标\n\n1. 支持中文与 \"引号\"\n2. 保留路径 `src\\\\plan.ts`";
    const call: ToolCall = {
      argumentsText: JSON.stringify({ markdown, title: "流式实现计划" }),
      callId: "call_plan_stream",
      index: 0,
      name: "submit_plan"
    };
    const registry = new RunRegistry();
    const controller = registry.startRun("run_plan_stream");
    await runAgent({
      model: "test",
      projectRoot: directory,
      prompt: "制定方案",
      provider: fragmentedPlanProvider(call, 5),
      registry,
      runId: "run_plan_stream",
      sessionId: "session_plan_stream",
      signal: controller.signal,
      store,
      tools: toolHost
    });
    registry.finishRun("run_plan_stream");

    const session = store.getSession("session_plan_stream")!;
    const activity = session.runs[0].activities.find((item) => item.tool?.callId === call.callId);
    assert.ok(activity);
    assert.equal(activity.kind, "plan");
    assert.equal(activity.title, "流式实现计划");
    assert.equal(activity.body, markdown);
    assert.equal(activity.status, "completed");
    assert.equal(session.plans[0].markdown, markdown);
    assert.equal(session.runs[0].status, "waiting");

    const updates = store.readEvents(session.sessionId).filter((event) => event.type === "activity.updated" && event.scope.activityId === activity.activityId);
    assert.ok(updates.filter((event) => typeof event.data.bodyDelta === "string").length >= 2);
    const serializedUpdates = JSON.stringify(updates);
    assert.equal(serializedUpdates.includes('"markdown"'), false);
    assert.equal(serializedUpdates.includes('"title"'), true, "semantic title updates remain observable");
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("suggested entry waits for user confirmation before changing mode", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-plan-entry-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, mode: "work", model: "test", planEntry: "suggest", projectRoot: directory, sessionId: "session_entry", title: "建议进入" });
    store.append({ data: { mode: "work", model: "test", prompt: "优化架构", startedAt: new Date().toISOString() }, runId: "run_entry", sessionId: "session_entry", type: "run.started" });
    const enterCall: ToolCall = { argumentsText: JSON.stringify({ reason: "涉及多个模块，需要先确认边界。" }), callId: "call_enter", index: 0, name: "enter_plan" };
    const registry = new RunRegistry();
    const controller = registry.startRun("run_entry");
    await runAgent({ model: "test", projectRoot: directory, prompt: "优化架构", provider: providerFor([{ call: enterCall }]), registry, runId: "run_entry", sessionId: "session_entry", signal: controller.signal, store, tools: toolHost });
    registry.finishRun("run_entry");

    let session = store.getSession("session_entry")!;
    assert.equal(session.mode, "work");
    assert.equal(session.runs[0].status, "waiting");
    assert.equal(session.questions[0].purpose, "plan_entry");
    const result = answerQuestion({ answers: { plan_entry: "进入计划模式" }, interactionId: session.questions[0].interactionId, sessionId: session.sessionId, store });
    session = result.session;
    assert.equal(session.mode, "plan");
    assert.equal(session.runs[0].status, "running");
    assert.equal(result.resume?.runId, "run_entry");
    assert.equal(JSON.parse(store.readContextEntries("session_entry").find((entry) => entry.toolCallKey === enterCall.callId)?.text ?? "{}").mode, "plan");
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("plan review decisions are idempotent and reject stale contradictory decisions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-plan-review-"));
  try {
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, mode: "plan", model: "test", projectRoot: directory, sessionId: "session_review", title: "审阅" });
    store.append({ data: { mode: "plan", model: "test", prompt: "规划", startedAt: new Date().toISOString() }, runId: "run_review", sessionId: "session_review", type: "run.started" });
    const at = new Date().toISOString();
    store.append({
      data: { plan: { callId: "call_plan", createdAt: at, markdown: "方案", planId: "plan_review", revision: 1, runId: "run_review", sessionId: "session_review", status: "proposed", title: "方案", updatedAt: at } },
      runId: "run_review",
      sessionId: "session_review",
      type: "plan.proposed"
    });
    const first = resolvePlan({ decision: "start_work", planId: "plan_review", revision: 1, sessionId: "session_review", store });
    const repeated = resolvePlan({ decision: "start_work", planId: "plan_review", revision: 1, sessionId: "session_review", store });
    assert.equal(first.idempotent, false);
    assert.equal(repeated.idempotent, true);
    assert.throws(() => resolvePlan({ decision: "continue_planning", planId: "plan_review", revision: 1, sessionId: "session_review", store }), /stale/);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
