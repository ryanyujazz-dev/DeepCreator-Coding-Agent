import assert from "node:assert/strict";
import test from "node:test";
import { ModelOutputItem } from "../shared/contracts/provider";
import { Activity, Run, ToolState, emptyChanges } from "../shared/contracts/runtime";
import { projectResponsesDisplayTimeline, responsesDisplayActivities } from "../shared/projections/responsesDisplayTimeline";

function tool(callId: string, callIndex: number, name = "read_file", action: ToolState["action"] = "inspect"): ToolState {
  return {
    action,
    argumentsPreview: "",
    callId,
    callIndex,
    effect: action === "modify" ? "workspace_write" : "read_only",
    modelStepId: "step_1",
    normalizedTarget: name === "web_search" ? "Responses API" : "src/App.tsx",
    targetKind: name === "web_search" ? "network" : action === "modify" ? "workspace" : "file",
    toolName: name
  };
}

function activity(id: string, overrides: Partial<Activity>): Activity {
  return {
    activityId: id,
    audience: "user",
    body: "",
    kind: "tool",
    runId: "run_responses",
    startedAt: `2026-08-01T10:00:${id.slice(-2).padStart(2, "0")}.000Z`,
    status: "completed",
    ...overrides
  };
}

function item(itemId: string, outputIndex: number, type: ModelOutputItem["type"], overrides: Partial<ModelOutputItem> = {}): ModelOutputItem {
  return {
    itemId,
    modelStepId: "step_1",
    outputIndex,
    sequence: outputIndex + 1,
    status: "completed",
    type,
    ...overrides
  };
}

function run(activities: Activity[], outputItems: ModelOutputItem[], status: Run["status"] = "running"): Run {
  return {
    activities,
    answer: "",
    approvals: [],
    changes: emptyChanges(),
    lastOffset: activities.length + outputItems.length,
    mode: "work",
    model: "deepseek-v4-flash",
    outputItems,
    prompt: "test",
    protocol: "responses",
    runId: "run_responses",
    sessionId: "session_responses",
    startedAt: "2026-08-01T10:00:00.000Z",
    status,
    tasks: []
  };
}

test("projects reasoning, message, and sealed function execution into one Chat-style segment", () => {
  const input = run([
    activity("thinking_01", { audience: "debug", kind: "thinking", modelItemId: "reasoning_1", modelStepId: "step_1", status: "suspended" }),
    activity("message_02", { body: "先读取配置。", kind: "message", modelItemId: "message_1", modelStepId: "step_1" }),
    activity("tool_03", { modelStepId: "step_1", tool: tool("call_1", 2) })
  ], [
    item("reasoning_1", 0, "reasoning"),
    item("message_1", 1, "message"),
    item("function_1", 2, "function", { callId: "call_1", toolName: "read_file" })
  ]);
  const entries = projectResponsesDisplayTimeline(input);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "display_segment");
  if (entries[0].type !== "display_segment") return;
  assert.equal(entries[0].segment.mainActivity?.body, "先读取配置。");
  assert.equal(entries[0].segment.aggregate?.successCount, 1);
  assert.equal(entries[0].segment.activitySlots[0]?.visual.label, "正在读取 App.tsx");
});

test("keeps completed native search in a tool-only segment before cited message content", () => {
  const input = run([
    activity("thinking_01", { audience: "debug", kind: "thinking", modelItemId: "reasoning_1", modelStepId: "step_1", status: "suspended" }),
    activity("search_02", { body: "Responses API", modelItemId: "search_1", modelStepId: "step_1", tool: tool("search_call", 1, "web_search", "search") }),
    activity("message_03", { body: "这是搜索后的回答。", kind: "message", modelItemId: "message_1", modelStepId: "step_1" })
  ], [
    item("reasoning_1", 0, "reasoning"),
    item("search_1", 1, "hosted_tool", { callId: "search_call", searchQuery: "Responses API", searchStatus: "completed", toolName: "web_search" }),
    item("message_1", 2, "message")
  ]);
  const entries = projectResponsesDisplayTimeline(input);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type === "display_segment" && entries[0].segment.aggregate?.memberActivityIds[0], "search_02");
  assert.equal(entries[1].type === "display_segment" && entries[1].segment.mainActivity?.body, "这是搜索后的回答。");
});

test("keeps apply_patch draft out of aggregate until Runtime execution starts", () => {
  const draft = activity("patch_02", {
    draft: { kind: "apply_patch", state: "waiting_approval", text: "*** Begin Patch\n*** End Patch" },
    modelItemId: "patch_item",
    modelStepId: "step_1",
    status: "suspended",
    tool: tool("patch_call", 1, "apply_patch", "modify")
  });
  const waiting = run([
    activity("thinking_01", { audience: "debug", kind: "thinking", modelItemId: "reasoning_1", modelStepId: "step_1", status: "suspended" }),
    draft
  ], [
    item("reasoning_1", 0, "reasoning"),
    item("patch_item", 1, "custom", { callId: "patch_call", draft: draft.draft?.text, toolName: "apply_patch" })
  ]);
  const waitingEntries = projectResponsesDisplayTimeline(waiting);
  assert.equal(waitingEntries.length, 1);
  assert.equal(waitingEntries[0].type === "display_segment" && waitingEntries[0].segment.aggregate, undefined);
  assert.equal(waitingEntries[0].type === "display_segment" && waitingEntries[0].segment.activitySlots[0]?.visual.label, "等待批准补丁");

  const applied = run([{ ...draft, kind: "file_mutation", status: "completed", draft: { ...draft.draft!, state: "applied" } }], waiting.outputItems!);
  assert.equal(responsesDisplayActivities(applied).find((candidate) => candidate.activityId.endsWith(":draft"))?.draft?.state, "applied");
  const appliedEntries = projectResponsesDisplayTimeline(applied);
  assert.equal(appliedEntries[0].type === "display_segment" && appliedEntries[0].segment.aggregate?.successCount, 1);
});

test("uses stable callIndex for parallel tools and starts the next message segment", () => {
  const input = run([
    activity("message_01", { body: "开始检查。", kind: "message", modelItemId: "message_1", modelStepId: "step_1" }),
    activity("tool_02", { modelStepId: "step_1", tool: tool("call_a", 1) }),
    activity("tool_03", { modelStepId: "step_1", tool: tool("call_b", 2, "git_status") }),
    activity("message_04", { body: "检查完成。", kind: "message", modelItemId: "message_2", modelStepId: "step_2" })
  ], [
    item("message_1", 0, "message"),
    item("function_a", 1, "function", { callId: "call_a", toolName: "read_file" }),
    item("function_b", 2, "function", { callId: "call_b", toolName: "git_status" }),
    item("reasoning_2", 0, "reasoning", { modelStepId: "step_2", sequence: 4 }),
    item("message_2", 1, "message", { modelStepId: "step_2", sequence: 5 })
  ]);
  const beforeNextMessage = projectResponsesDisplayTimeline({
    ...input,
    activities: input.activities.slice(0, 3),
    outputItems: input.outputItems?.slice(0, 3)
  });
  assert.equal(beforeNextMessage[0].type === "display_segment" && beforeNextMessage[0].segment.activitySlots[0]?.visual.sourceActivityId, "tool_03");
  const entries = projectResponsesDisplayTimeline(input);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type === "display_segment" && entries[0].segment.aggregate?.totalCalls, 2);
  assert.equal(entries[0].type === "display_segment" && entries[0].segment.activitySlots.length, 0);
  assert.equal(entries[1].type === "display_segment" && entries[1].segment.mainActivity?.body, "检查完成。");
});

test("retains partial content and unapplied patch without inventing a failed tool execution", () => {
  const failedDraft = activity("patch_02", {
    draft: { kind: "apply_patch", state: "failed", text: "*** Begin Patch" },
    error: "provider failed",
    modelItemId: "patch_item",
    modelStepId: "step_1",
    status: "failed",
    tool: tool("patch_call", 1, "apply_patch", "modify")
  });
  const input = run([
    activity("message_01", { body: "部分正文", kind: "message", modelItemId: "message_1", modelStepId: "step_1" }),
    failedDraft
  ], [
    item("message_1", 0, "message"),
    item("patch_item", 1, "custom", { callId: "patch_call", draft: failedDraft.draft?.text, status: "failed", toolName: "apply_patch" })
  ], "failed");
  const displayActivities = responsesDisplayActivities(input);
  assert.equal(displayActivities.some((candidate) => candidate.activityId === "patch_02"), false);
  const entries = projectResponsesDisplayTimeline(input);
  assert.equal(entries[0].type === "display_segment" && entries[0].segment.mainActivity?.body, "部分正文");
  assert.equal(entries[0].type === "display_segment" && entries[0].segment.aggregate, undefined);
});
