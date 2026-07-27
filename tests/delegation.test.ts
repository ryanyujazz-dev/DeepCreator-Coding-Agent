import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agentDefinition, createAgentToolHost } from "../server/app/agentDefinitions";
import { DelegationCoordinator } from "../server/app/delegationCoordinator";
import { RunRegistry } from "../server/app/runRegistry";
import { Runner } from "../server/app/runner";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { toolHost } from "../server/infra/tools";
import { Provider } from "../shared/contracts/provider";
import { testSystem } from "./support/system";

test("delegate creates an independent hidden session and asynchronously delivers one typed result", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-delegation-"));
  try {
    const system = testSystem;
    const store = new RuntimeStore(directory, undefined, system);
    const registry = new RunRegistry(system);
    store.createSession({
      accessMode: "full_access",
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_parent",
      title: "Parent"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "parent prompt", startedAt: system.now() },
      runId: "run_parent",
      sessionId: "session_parent",
      type: "run.started"
    });
    store.append({
      activityId: "activity_delegate",
      data: {
        audience: "user",
        kind: "delegation",
        startedAt: system.now(),
        tool: {
          action: "execute",
          argumentsPreview: "{}",
          callId: "call_delegate",
          effect: "control_only",
          modelStepId: "step_delegate",
          normalizedTarget: "explorer",
          targetKind: "workspace",
          toolName: "delegate"
        }
      },
      runId: "run_parent",
      sessionId: "session_parent",
      type: "activity.started"
    });
    store.appendContextEntry({
      kind: "human_text",
      runId: "run_parent",
      sessionId: "session_parent",
      source: "user",
      text: "PARENT_HISTORY_MUST_NOT_LEAK"
    });
    const launcher = {
      launch(input: { runId: string }) {
        registry.startRun(input.runId);
      }
    };
    const coordinator = new DelegationCoordinator(launcher, registry, store, system);
    const receipt = coordinator.delegate({
      activityId: "activity_delegate",
      agent: "explorer",
      callId: "call_delegate",
      message: "Inspect the route registration",
      model: "test",
      parentRunId: "run_parent",
      parentSessionId: "session_parent",
      projectRoot: directory
    });

    const child = store.getSession(receipt.childSessionId)!;
    assert.equal(child.kind, "subagent");
    assert.equal(child.agentId, "explorer");
    assert.equal(child.runs[0].prompt, "Inspect the route registration");
    assert.equal(store.listSessions().some((item) => item.sessionId === child.sessionId), false);
    assert.deepEqual(store.readContextEntries(child.sessionId).map((record) => ({ kind: record.kind, text: record.text })), [{
      kind: "human_text",
      text: "Inspect the route registration"
    }]);

    let requestMessages: import("../shared/contracts/provider").ModelMessage[] = [];
    let requestTools: string[] = [];
    const provider: Provider = {
      capabilities: {
        contextWindowTokens: 1_000_000,
        supportsParallelToolCalls: true,
        supportsStrictTools: false,
        supportsThinking: true,
        supportsTools: true
      },
      async stream(request) {
        requestMessages = request.messages;
        requestTools = request.tools.map((tool) => tool.name);
        return {
          answer: "  Exact child content\n",
          continuationMessage: { role: "assistant", text: "  Exact child content\n" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };
    await new Runner(toolHost).run({
      model: "test",
      projectRoot: directory,
      prompt: "Inspect the route registration",
      provider,
      registry,
      runId: receipt.childRunId,
      sessionId: receipt.childSessionId,
      signal: registry.beginInterruptibleStep(receipt.childRunId).signal,
      store
    });
    assert.match(requestMessages[0].text ?? "", /Explorer 子代理/);
    assert.doesNotMatch(requestMessages[0].text ?? "", /你是 DeepSeeker CodeAgent/);
    assert.equal(requestMessages.some((message) => message.text?.includes("PARENT_HISTORY_MUST_NOT_LEAK")), false);
    assert.equal(requestMessages.filter((message) => message.text === "Inspect the route registration").length, 1);
    assert.deepEqual(requestTools.sort(), [...agentDefinition("explorer").tools].sort());
    registry.finishRun(receipt.childRunId);

    const parent = store.getSession("session_parent")!;
    assert.equal(parent.delegations?.[0].content, "  Exact child content\n");
    assert.equal(parent.delegations?.[0].deliveryStatus, "pending");
    const results = coordinator.takeResults("run_parent");
    assert.equal(results.length, 1);
    assert.match(results[0].text ?? "", / {2}Exact child content\\n/);
    assert.equal(store.getSession("session_parent")?.delegations?.[0].deliveryStatus, "delivered");
    assert.equal(store.readContextEntries("session_parent").filter((item) => item.kind === "delegation_result").length, 1);
    store.close();
  } finally {
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* SQLite cleanup can fail on Windows. */ }
  }
});

test("built-in agent profiles enforce fixed tools and forbid nested delegation", () => {
  const explorer = createAgentToolHost(toolHost, agentDefinition("explorer"));
  const worker = createAgentToolHost(toolHost, agentDefinition("worker"));
  assert.equal(explorer.has("read_file"), true);
  assert.equal(explorer.has("write_file"), false);
  assert.equal(explorer.has("delegate"), false);
  assert.equal(worker.has("write_file"), true);
  assert.equal(worker.has("run_command"), true);
  assert.equal(worker.has("delegate"), false);
  assert.equal(toolHost.has("spawn_agent"), true);
  assert.equal(toolHost.names().includes("spawn_agent"), false);
  assert.equal(toolHost.specs.some((tool) => tool.name === "spawn_agent"), false);
});

test("parent completion waits for a typed delegation result without emitting a second tool result", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-delegation-gate-"));
  const system = testSystem;
  const store = new RuntimeStore(directory, undefined, system);
  const registry = new RunRegistry(system);
  try {
    store.createSession({
      accessMode: "full_access",
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_gate_parent",
      title: "Parent completion gate"
    });
    store.append({
      data: { mode: "work", model: "test", prompt: "delegate a check", startedAt: system.now() },
      runId: "run_gate_parent",
      sessionId: "session_gate_parent",
      type: "run.started"
    });
    const parentController = registry.startRun("run_gate_parent");
    const coordinator = new DelegationCoordinator({
      launch(input) {
        registry.startRun(input.runId);
      }
    }, registry, store, system);
    const runner = new Runner(toolHost);
    runner.setDelegationCoordinator(coordinator);
    const delegateCall = {
      argumentsText: JSON.stringify({ agent: "explorer", message: "Inspect routing" }),
      callId: "call_gate_delegate",
      index: 0,
      name: "delegate"
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
          assert.equal(request.tools.some((tool) => tool.name === "delegate"), true);
          return {
            answer: "",
            continuationMessage: { role: "assistant", text: null, toolCalls: [delegateCall] },
            finishCause: "tool_calls",
            thinking: "",
            toolCalls: [delegateCall]
          };
        }
        if (turn === 2) {
          const delegation = store.getSession("session_gate_parent")?.delegations?.[0];
          assert.ok(delegation);
          setTimeout(() => {
            store.append({
              data: { answer: "child terminal payload", finishedAt: system.now(), status: "completed" },
              runId: delegation.childRunId,
              sessionId: delegation.childSessionId,
              type: "run.finished"
            });
            registry.finishRun(delegation.childRunId);
          }, 5);
          return {
            answer: "premature parent answer",
            continuationMessage: { role: "assistant", text: "premature parent answer" },
            finishCause: "complete",
            thinking: "",
            toolCalls: []
          };
        }
        assert.equal(request.messages.at(-1)?.role, "user");
        assert.match(request.messages.at(-1)?.text ?? "", /child terminal payload/);
        return {
          answer: "parent final after child",
          continuationMessage: { role: "assistant", text: "parent final after child" },
          finishCause: "complete",
          thinking: "",
          toolCalls: []
        };
      }
    };

    await runner.run({
      model: "test",
      projectRoot: directory,
      prompt: "delegate a check",
      provider,
      registry,
      runId: "run_gate_parent",
      sessionId: "session_gate_parent",
      signal: parentController.signal,
      store
    });
    registry.finishRun("run_gate_parent");

    assert.equal(turn, 3);
    assert.equal(store.getRun("run_gate_parent")?.answer, "parent final after child");
    const records = store.readContextEntries("session_gate_parent");
    assert.equal(records.filter((record) => record.kind === "tool_result" && record.toolCallKey === "call_gate_delegate").length, 1);
    assert.equal(records.filter((record) => record.kind === "delegation_result").length, 1);
  } finally {
    store.close();
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* SQLite cleanup can fail on Windows. */ }
  }
});

test("delegation enforces the four-child limit and parent cancellation cascades", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-delegation-limit-"));
  const store = new RuntimeStore(directory, undefined, testSystem);
  const registry = new RunRegistry(testSystem);
  try {
    store.createSession({
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      model: "test",
      projectRoot: directory,
      sessionId: "session_limit_parent",
      title: "Delegation limit"
    });
    store.append({
      data: { model: "test", prompt: "delegate several checks", startedAt: testSystem.now() },
      runId: "run_limit_parent",
      sessionId: "session_limit_parent",
      type: "run.started"
    });
    const parentController = registry.startRun("run_limit_parent");
    const childControllers = new Map<string, AbortController>();
    const coordinator = new DelegationCoordinator({
      launch(input) {
        childControllers.set(input.runId, registry.startRun(input.runId));
      }
    }, registry, store, testSystem);
    for (let index = 0; index < 4; index += 1) {
      coordinator.delegate({
        activityId: `activity_limit_${index}`,
        agent: "explorer",
        callId: `call_limit_${index}`,
        message: `Inspect area ${index}`,
        model: "test",
        parentRunId: "run_limit_parent",
        parentSessionId: "session_limit_parent",
        projectRoot: directory
      });
    }
    assert.throws(() => coordinator.delegate({
      activityId: "activity_limit_5",
      agent: "worker",
      callId: "call_limit_5",
      message: "Fifth child",
      model: "test",
      parentRunId: "run_limit_parent",
      parentSessionId: "session_limit_parent",
      projectRoot: directory
    }), /最多只能执行 4 个子代理/);

    assert.equal(registry.cancelRun("run_limit_parent"), true);
    assert.equal(parentController.signal.aborted, true);
    assert.equal([...childControllers.values()].every((controller) => controller.signal.aborted), true);
  } finally {
    store.close();
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* SQLite cleanup can fail on Windows. */ }
  }
});
