import assert from "node:assert/strict";
import test from "node:test";
import { projectGroups } from "../shared/projections/groups";
import { createSession, rebuildSession, reduceEvent, reduceEvents } from "../shared/domain/reducer";
import { Event, EventPayloadMap, EventType, EVENT_VERSION } from "../shared/contracts/runtime";

const registration = {
  compactThresholdTokens: 850_000,
  contextWindowTokens: 1_000_000,
  createdAt: "2026-07-17T10:00:00.000Z",
  model: "deepseek-chat",
  projectRoot: "/tmp/project",
  sessionId: "session_test",
  title: "测试会话"
};

function event<K extends EventType>(offset: number, type: K, data: EventPayloadMap[K], activityId?: string): Event<K> {
  return {
    version: EVENT_VERSION,
    at: `2026-07-17T10:00:0${offset}.000Z`,
    data,
    offset,
    scope: { runId: "run_test", sessionId: registration.sessionId, activityId },
    eventId: `session_test:${offset}`,
    type
  } as Event<K>;
}

test("reduces lifecycle signals and treats settlement as authoritative", () => {
  const initial = createSession(registration, 1);
  assert.equal(initial.workspaceKind, "project");
  const events = [
    event(2, "run.started", { model: "deepseek-chat", prompt: "修复测试", startedAt: "2026-07-17T10:00:02.000Z" }),
    event(3, "reasoning.updated", { modelStepId: "model_step_1", textDelta: "先理解问题。" }),
    event(4, "reasoning.title.updated", { title: "核对问题实现范围" }),
    event(5, "activity.started", { audience: "debug", kind: "thinking", startedAt: "2026-07-17T10:00:04.000Z", title: "" }, "activity_1"),
    event(6, "activity.updated", { bodyDelta: "检查上下文" }, "activity_1"),
    event(7, "activity.finished", { status: "completed", finishedAt: "2026-07-17T10:00:06.000Z" }, "activity_1"),
    event(8, "run.finished", { answer: "已完成", status: "completed", finishedAt: "2026-07-17T10:00:07.000Z" })
  ];
  const result = reduceEvents(initial, events);
  assert.equal(result.runs[0].status, "completed");
  assert.equal(result.runs[0].answer, "已完成");
  assert.equal(result.runs[0].reasoning, "先理解问题。");
  assert.deepEqual(result.runs[0].reasoningSteps, [{ modelStepId: "model_step_1", text: "先理解问题。" }]);
  assert.equal(result.runs[0].reasoningTitle, "核对问题实现范围");
  assert.equal(result.runs[0].activities[0].body, "检查上下文");
  assert.equal(result.runs[0].activities[0].status, "completed");
});

test("groups reasoning deltas by model step while preserving the aggregate", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-chat", prompt: "分析", startedAt: registration.createdAt }),
    event(3, "reasoning.updated", { modelStepId: "model_step_a", textDelta: "先定位" }),
    event(4, "reasoning.updated", { modelStepId: "model_step_a", textDelta: "文件。" }),
    event(5, "reasoning.updated", { modelStepId: "model_step_b", textDelta: "再验证实现。" })
  ]);

  assert.deepEqual(result.runs[0].reasoningSteps, [
    { modelStepId: "model_step_a", text: "先定位文件。" },
    { modelStepId: "model_step_b", text: "再验证实现。" }
  ]);
  assert.equal(result.runs[0].reasoning, "先定位文件。\n\n再验证实现。");
});

test("persists the selected protocol and replaces semantic output item snapshots by item id", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-v4-flash", prompt: "分析", protocol: "responses", startedAt: registration.createdAt }),
    event(3, "model.output_item.changed", { item: { itemId: "item_1", modelStepId: "step_1", outputIndex: 0, sequence: 1, status: "generating", text: "先", type: "reasoning" } }),
    event(4, "model.output_item.changed", { item: { itemId: "item_1", modelStepId: "step_1", outputIndex: 0, sequence: 2, status: "completed", text: "先检查", type: "reasoning" } })
  ]);
  assert.equal(result.runs[0].protocol, "responses");
  assert.deepEqual(result.runs[0].outputItems, [{ itemId: "item_1", modelStepId: "step_1", outputIndex: 0, sequence: 2, status: "completed", text: "先检查", type: "reasoning" }]);
});

test("keeps repeated provider item ids distinct across model steps", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-v4-flash", prompt: "分析", protocol: "responses", startedAt: registration.createdAt }),
    event(3, "model.output_item.changed", { item: { itemId: "item_1", modelStepId: "step_1", outputIndex: 0, sequence: 1, status: "completed", type: "message" } }),
    event(4, "model.output_item.changed", { item: { itemId: "item_1", modelStepId: "step_2", outputIndex: 0, sequence: 1, status: "completed", type: "message" } })
  ]);
  assert.deepEqual(result.runs[0].outputItems?.map((item) => item.modelStepId), ["step_1", "step_2"]);
});

test("keeps unkeyed legacy reasoning out of the visual step projection", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-chat", prompt: "分析", startedAt: registration.createdAt }),
    event(3, "reasoning.updated", { textDelta: "无法恢复边界的历史思考" })
  ]);

  assert.equal(result.runs[0].reasoning, "无法恢复边界的历史思考");
  assert.equal(result.runs[0].reasoningSteps, undefined);
});

test("ignores duplicate and stale offsets", () => {
  const initial = createSession(registration, 1);
  const accepted = event(2, "run.started", { model: "deepseek-chat", prompt: "测试", startedAt: registration.createdAt });
  const once = reduceEvent(initial, accepted);
  const twice = reduceEvent(once, accepted);
  assert.equal(twice.runs.length, 1);
  assert.equal(twice.lastOffset, 2);
});

test("keeps the model-owned tasks unchanged when a run terminates unsuccessfully", () => {
  const result = reduceEvents(createSession(registration, 1), [
    event(2, "run.started", { model: "deepseek-chat", prompt: "修改代码", startedAt: registration.createdAt }),
    event(4, "tasks.changed", {
      items: [
        { label: "修改文件", status: "running", taskId: "edit" },
        { label: "运行测试", status: "pending", taskId: "test" }
      ]
    }),
    event(5, "run.finished", {
      error: "Runtime restarted",
      status: "failed",
      finishedAt: "2026-07-17T10:00:05.000Z"
    })
  ]);
  assert.equal(result.runs[0].tasks[0].status, "running");
  assert.equal(result.runs[0].tasks[1].status, "pending");
});

test("replay produces the same semantic activity projection as live reduction", () => {
  const registered: Event = {
    version: EVENT_VERSION,
    at: registration.createdAt,
    offset: 1,
    data: registration,
    scope: { sessionId: registration.sessionId },
    eventId: "session_test:1",
    type: "session.created"
  };
  const toolFact = {
    groupMode: "consecutive" as const,
    argumentsPreview: "{\"path\":\"src/App.tsx\"}",
    callId: "call_replay",
    detail: { defaultCollapsed: true, pathStyle: "workspace_relative" as const, previewLimit: 5 },
    displayTarget: "src/App.tsx",
    effect: "read_only" as const,
    importance: "routine" as const,
    modelStepId: "model_step_replay",
    normalizedTarget: "src/App.tsx",
    action: "inspect" as const,
    targetKind: "file" as const,
    toolName: "read_file"
  };
  const events = [
    event(2, "run.started", { model: registration.model, prompt: "检查文件", startedAt: registration.createdAt }),
    event(4, "activity.started", {
      audience: "user",
      kind: "tool",
      startedAt: "2026-07-17T10:00:04.000Z",
      title: "读取文件",
      tool: toolFact
    }, "unit_replay"),
    event(5, "activity.updated", {
      tool: { resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    event(6, "activity.finished", {
      status: "completed",
      finishedAt: "2026-07-17T10:00:06.000Z",
      tool: { ...toolFact, resultMetrics: { byteCount: 128, itemCount: 1 } }
    }, "unit_replay"),
    event(7, "run.finished", { answer: "检查完成", status: "completed", finishedAt: "2026-07-17T10:00:07.000Z" })
  ];

  const live = reduceEvents(createSession(registration, 1), events);
  const replayed = rebuildSession([registered, ...events]);
  assert.ok(replayed);
  assert.deepEqual(replayed, live);
  assert.deepEqual(
    projectGroups(replayed.runs[0]),
    projectGroups(live.runs[0])
  );
});

// ---- Phase 2: 结构性共享(structural sharing)不变式 ----
// reducer 不再整体 structuredClone 整个 session,而是浅拷贝脊柱 + 按变更路径 copy-on-write。以下
// 三组测试锁定该不变式,它们是值相等测试抓不到的回归网:(1) 不就地改输入;(2) 未触及子树保持引用
// (下游 React.memo / RunTimeline 据此跳过未变 run);(3) tool 合并这一最易踩坑的路径产出正确值且
// 不污染共享对象。

// 递归冻结:把 reduceEvents 的输入冻成只读。结构性共享实现绝不就地修改输入(只读 current 后建新对象);
// 若误写「就地改共享引用」(如 current.runs.push / 原地 Object.assign 共享元素),严格模式冻结会抛
// TypeError → 测试失败。这正是 value 对了但偷偷改了输入 → 下游 memo 失效 / 跨事件交叉污染的失败模式。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// 多 run 事件构造器:复用 event() 的形状,但允许指定 runId(结构性共享测试需要并发多个 run)。
function runEvent<K extends EventType>(runId: string, offset: number, type: K, data: EventPayloadMap[K], activityId?: string): Event<K> {
  return {
    version: EVENT_VERSION,
    at: `2026-07-17T10:00:0${offset}.000Z`,
    data,
    offset,
    scope: { runId, sessionId: registration.sessionId, activityId },
    eventId: `session_test:${runId}:${offset}`,
    type
  } as Event<K>;
}

const startedAt = registration.createdAt;
const finishedAt = registration.createdAt;
const toolFact = {
  callId: "call_struct",
  modelStepId: "model_step_struct",
  toolName: "read_file",
  action: "inspect" as const,
  targetKind: "file" as const,
  effect: "read_only" as const,
  normalizedTarget: "src/App.tsx",
  argumentsPreview: "abc"
};

test("reduceEvents 不就地修改输入:冻结的 session 与 events 回放不抛", () => {
  const initial = createSession(registration, 1);
  const events = [
    event(2, "run.started", { model: "deepseek-chat", prompt: "冻结", startedAt }),
    event(3, "reasoning.updated", { modelStepId: "m1", textDelta: "一段。" }),
    event(4, "reasoning.updated", { modelStepId: "m1", textDelta: "二段。" }),
    event(5, "reasoning.updated", { modelStepId: "m2", textDelta: "新步。" }),
    event(6, "activity.started", { audience: "user", kind: "thinking", startedAt, title: "" }, "a1"),
    event(7, "activity.updated", { bodyDelta: "正文", status: "suspended", kind: "thinking", title: "T" }, "a1"),
    event(8, "activity.finished", { status: "completed", finishedAt }, "a1"),
    event(9, "tasks.changed", { items: [{ label: "t", status: "pending", taskId: "t1" }] }),
    event(10, "changes.changed", { fileCount: 1, additions: 2, deletions: 3, files: [{ path: "a", additions: 2, deletions: 3, operation: "edited" as const }] }),
    event(11, "usage.changed", { source: "estimated", contextTokens: 123 }),
    event(12, "run.finished", { answer: "ok", status: "completed", finishedAt })
  ];
  deepFreeze(initial);
  for (const e of events) deepFreeze(e);
  // 不抛即通过:没有任何就地修改冻结输入的代码路径。
  const result = reduceEvents(initial, events);
  assert.equal(result.runs[0].status, "completed");
  assert.equal(result.runs[0].reasoning, "一段。二段。\n\n新步。");
  assert.equal(result.runs[0].activities[0].body, "正文");
  assert.equal(result.runs[0].activities[0].status, "completed");
});

test("结构性共享:未触及的 run 与子树保持引用,仅被改路径换新引用", () => {
  // 两个 run:run_a 跑完(后续不再触及),run_b running(后续追加 reasoning 增量)。
  const s0 = createSession(registration, 1);
  const s1 = reduceEvents(s0, [
    runEvent("run_a", 2, "run.started", { model: "deepseek-chat", prompt: "A", startedAt }),
    runEvent("run_a", 3, "reasoning.updated", { modelStepId: "ma", textDelta: "A 思考。" }),
    runEvent("run_a", 4, "run.finished", { answer: "A 答", status: "completed", finishedAt }),
    runEvent("run_b", 5, "run.started", { model: "deepseek-chat", prompt: "B", startedAt })
  ]);

  const runARef = s1.runs[0];
  const runBRef = s1.runs[1];
  const runsRef = s1.runs;
  const plansRef = s1.plans;
  const questionsRef = s1.questions;
  const followUpsRef = s1.followUps;
  const runAActivitiesRef = runARef.activities;
  const runAReasoningRef = runARef.reasoning;

  // 只对 run_b 追加一条 reasoning 增量。
  const s2 = reduceEvents(s1, [runEvent("run_b", 6, "reasoning.updated", { textDelta: "B 增量。" })]);

  assert.notEqual(s2, s1, "session 脊柱换新引用");
  assert.notEqual(s2.runs, runsRef, "runs 数组换新引用(copy-on-write)");
  assert.strictEqual(s2.runs[0], runARef, "未触及的 run_a 保持原引用(memo 据此跳过)");
  assert.notEqual(s2.runs[1], runBRef, "被改的 run_b 换新引用");
  assert.strictEqual(s2.runs[0].activities, runAActivitiesRef, "run_a.activities 保持原引用");
  assert.strictEqual(s2.runs[0].reasoning, runAReasoningRef, "run_a.reasoning 保持原引用");
  assert.strictEqual(s2.plans, plansRef, "未触及的 plans 保持原引用");
  assert.strictEqual(s2.questions, questionsRef, "未触及的 questions 保持原引用");
  assert.strictEqual(s2.followUps, followUpsRef, "未触及的 followUps 保持原引用");
  assert.equal(s2.runs[1].reasoning, "B 增量。");
});

test("结构性共享:run.finished 的 activities copy-on-write —— 已完成 activity 元素保持引用,运行中换新", () => {
  // run.finished 用 activities.map 对 running/suspended 换新引用、对已完成项 return activity(保持引用)。
  // 该分支不走 withUpdatedElement,需单独断言:已完成 activity 元素引用稳定(memo 据此跳过);
  // 否则回归(把 return activity 改成 return {...activity})会静默击穿下游 memo 且无测试信号。
  const s0 = createSession(registration, 1);
  const s1 = reduceEvents(s0, [
    runEvent("run_x", 2, "run.started", { model: "deepseek-chat", prompt: "X", startedAt }),
    runEvent("run_x", 3, "activity.started", { audience: "user", kind: "thinking", startedAt, title: "" }, "ax_done"),
    runEvent("run_x", 4, "activity.finished", { status: "completed", finishedAt }, "ax_done"),
    runEvent("run_x", 5, "activity.started", { audience: "user", kind: "tool", startedAt, title: "" }, "ax_run")
  ]);
  const doneActivityBefore = s1.runs[0].activities[0];
  const runningActivityBefore = s1.runs[0].activities[1];
  assert.equal(runningActivityBefore.status, "running");

  const s2 = reduceEvents(s1, [runEvent("run_x", 6, "run.finished", { answer: "ok", status: "completed", finishedAt })]);

  assert.strictEqual(s2.runs[0].activities[0], doneActivityBefore, "已完成 activity 元素引用保持(return activity 分支)");
  assert.notStrictEqual(s2.runs[0].activities[1], runningActivityBefore, "running activity 元素换新引用");
  assert.equal(s2.runs[0].activities[1].status, "failed", "run 完成时 running activity 归为 failed");
});

test("activity.updated:argumentsDelta 与 tool 部分合并到新 tool 对象,共享原 tool 不被污染", () => {
  const setup = reduceEvents(createSession(registration, 1), [
    runEvent("run_t", 2, "run.started", { model: "deepseek-chat", prompt: "T", startedAt }),
    runEvent("run_t", 3, "activity.started", { audience: "user", kind: "tool", startedAt, title: "", tool: toolFact }, "at_t")
  ]);
  const toolBefore = setup.runs[0].activities[0].tool;

  const after = reduceEvents(setup, [
    runEvent("run_t", 4, "activity.updated", { argumentsDelta: "XYZ", tool: { resultMetrics: { byteCount: 5, itemCount: 1 } } }, "at_t")
  ]).runs[0].activities[0];

  assert.equal(after.tool?.argumentsPreview, "abcXYZ", "argumentsDelta 合入新 tool");
  assert.deepEqual(after.tool?.resultMetrics, { byteCount: 5, itemCount: 1 }, "tool 部分合并");
  assert.notEqual(after.tool, toolBefore, "tool 换新引用(未就地改共享对象)");
  assert.equal(toolBefore?.argumentsPreview, "abc", "共享原 tool 未被污染");
});

// 回归:delegation.created 必须只设置父 activity 的 .delegation 字段,而不能用 delegation 子对象整体覆盖
// 该 activity —— 否则 activity 的身份字段(activityId/kind/body/...)被抹掉,后续 activity.finished 的
// assertEventTransition 找不到该 activity,父运行在委派工具收尾时抛错。scope 仅 sessionId(无 runId),
// 复刻 createDelegatedRun 的真实事件形状。
test("delegation.created 仅设置父 activity 的 .delegation 字段,不覆盖 activity 身份", () => {
  const setup = reduceEvents(createSession(registration, 1), [
    runEvent("run_d", 2, "run.started", { model: "deepseek-chat", prompt: "D", startedAt }),
    runEvent("run_d", 3, "activity.started", { audience: "user", kind: "tool", startedAt, title: "委派工具", tool: toolFact }, "act_d")
  ]);
  const delegation = {
    agentId: "explorer" as const,
    childRunId: "child_run",
    childSessionId: "child_session",
    createdAt: startedAt,
    deliveryStatus: "pending" as const,
    delegationId: "del_1",
    message: "检查路由",
    parentActivityId: "act_d",
    parentCallId: "call_d",
    parentRunId: "run_d",
    parentSessionId: registration.sessionId,
    status: "running" as const,
    updatedAt: startedAt
  };
  const result = reduceEvents(setup, [
    {
      version: EVENT_VERSION,
      at: startedAt,
      offset: 4,
      data: { delegation },
      scope: { sessionId: registration.sessionId },
      eventId: "session_test:del:4",
      type: "delegation.created"
    }
  ]);

  const activity = result.runs[0].activities[0];
  assert.equal(activity.activityId, "act_d", "activityId 保留(未被 delegation 子对象覆盖)");
  assert.equal(activity.kind, "tool", "kind 保留");
  assert.equal(activity.title, "委派工具", "title 保留");
  assert.equal(activity.body, "", "body 保留");
  assert.equal(activity.delegation?.delegationId, "del_1", ".delegation 字段已设置");
  assert.equal(activity.delegation?.childRunId, "child_run", ".delegation 子字段正确");
  assert.equal(result.delegations?.[0]?.delegationId, "del_1", "session.delegations 记录委派");
});
