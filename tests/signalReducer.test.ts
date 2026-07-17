import assert from "node:assert/strict";
import test from "node:test";
import { projectOperationGroups } from "../shared/operationGroupProjector";
import { createSessionView, rebuildSession, reduceSignal, reduceSignals } from "../shared/signalReducer";
import { AgentSignal, SIGNAL_CONTRACT } from "../shared/runtimeTypes";

const registration = {
  compactThresholdTokens: 850_000,
  contextWindowTokens: 1_000_000,
  createdAt: "2026-07-17T10:00:00.000Z",
  model: "deepseek-chat",
  projectRoot: "/tmp/project",
  sessionKey: "session_test",
  title: "测试会话"
};

function signal(offset: number, topic: AgentSignal["topic"], payload: unknown, unitKey?: string): AgentSignal {
  return {
    contract: SIGNAL_CONTRACT,
    emittedAt: `2026-07-17T10:00:0${offset}.000Z`,
    offset,
    payload,
    scope: { cycleKey: "cycle_test", sessionKey: registration.sessionKey, unitKey },
    signalKey: `session_test:${offset}`,
    topic
  };
}

test("reduces lifecycle signals and treats settlement as authoritative", () => {
  const initial = createSessionView(registration, 1);
  const signals = [
    signal(2, "cycle.accepted", { model: "deepseek-chat", prompt: "修复测试", startedAt: "2026-07-17T10:00:02.000Z" }),
    signal(3, "cycle.executing", {}),
    signal(4, "unit.opened", { audience: "debug", kind: "thinking", openedAt: "2026-07-17T10:00:04.000Z", title: "正在思考" }, "activity_1"),
    signal(5, "unit.thinking.appended", { text: "检查上下文" }, "activity_1"),
    signal(6, "unit.sealed", { phase: "succeeded", sealedAt: "2026-07-17T10:00:06.000Z", title: "思考完成" }, "activity_1"),
    signal(7, "cycle.settled", { finalResponse: "已完成", phase: "succeeded", settledAt: "2026-07-17T10:00:07.000Z" })
  ];
  const result = reduceSignals(initial, signals);
  assert.equal(result.cycles[0].phase, "succeeded");
  assert.equal(result.cycles[0].finalResponse, "已完成");
  assert.equal(result.cycles[0].units[0].body, "检查上下文");
  assert.equal(result.cycles[0].units[0].phase, "succeeded");
});

test("ignores duplicate and stale offsets", () => {
  const initial = createSessionView(registration, 1);
  const accepted = signal(2, "cycle.accepted", { model: "deepseek-chat", prompt: "测试", startedAt: registration.createdAt });
  const once = reduceSignal(initial, accepted);
  const twice = reduceSignal(once, accepted);
  assert.equal(twice.cycles.length, 1);
  assert.equal(twice.lastOffset, 2);
});

test("keeps the model-owned plan unchanged when a cycle terminates unsuccessfully", () => {
  const result = reduceSignals(createSessionView(registration, 1), [
    signal(2, "cycle.accepted", { model: "deepseek-chat", prompt: "修改代码", startedAt: registration.createdAt }),
    signal(3, "cycle.executing", {}),
    signal(4, "cycle.plan.replaced", {
      steps: [
        { label: "修改文件", state: "in_progress", stepKey: "edit" },
        { label: "运行测试", state: "pending", stepKey: "test" }
      ]
    }),
    signal(5, "cycle.settled", {
      failure: "Runtime restarted",
      phase: "failed",
      settledAt: "2026-07-17T10:00:05.000Z"
    })
  ]);
  assert.equal(result.cycles[0].plan[0].state, "in_progress");
  assert.equal(result.cycles[0].plan[1].state, "pending");
});

test("replay produces the same semantic operation projection as live reduction", () => {
  const registered: AgentSignal = {
    contract: SIGNAL_CONTRACT,
    emittedAt: registration.createdAt,
    offset: 1,
    payload: registration,
    scope: { sessionKey: registration.sessionKey },
    signalKey: "session_test:1",
    topic: "session.registered"
  };
  const toolFact = {
    aggregationPolicy: "consecutive" as const,
    argumentsPreview: "{\"path\":\"src/App.tsx\"}",
    callKey: "call_replay",
    detailPolicy: { defaultCollapsed: true, pathStyle: "workspace_relative" as const, previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effectKind: "read_only" as const,
    importance: "routine" as const,
    modelStepKey: "model_step_replay",
    normalizedTarget: "src/App.tsx",
    operationClass: "inspect" as const,
    resourceKind: "file" as const,
    toolName: "read_file"
  };
  const signals = [
    signal(2, "cycle.accepted", { model: registration.model, prompt: "检查文件", startedAt: registration.createdAt }),
    signal(3, "cycle.executing", {}),
    signal(4, "unit.opened", {
      audience: "user",
      kind: "tool",
      openedAt: "2026-07-17T10:00:04.000Z",
      title: "读取文件",
      tool: toolFact
    }, "unit_replay"),
    signal(5, "unit.tool.updated", {
      tool: { resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    signal(6, "unit.sealed", {
      phase: "succeeded",
      sealedAt: "2026-07-17T10:00:06.000Z",
      tool: { ...toolFact, resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    signal(7, "cycle.settled", { finalResponse: "检查完成", phase: "succeeded", settledAt: "2026-07-17T10:00:07.000Z" })
  ];

  const live = reduceSignals(createSessionView(registration, 1), signals);
  const replayed = rebuildSession([registered, ...signals]);
  assert.ok(replayed);
  assert.deepEqual(replayed, live);
  assert.deepEqual(
    projectOperationGroups(replayed.cycles[0]),
    projectOperationGroups(live.cycles[0])
  );
});
