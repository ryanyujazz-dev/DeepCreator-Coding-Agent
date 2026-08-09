import assert from "node:assert/strict";
import test from "node:test";
import { Activity, emptyChanges, EVENT_VERSION, Event, Run, Session } from "../shared/contracts/runtime";
import { HeuristicContentJudge } from "../evals/src/contentJudge";
import { findCase, loadDataset, loadFixture } from "../evals/src/dataset";
import { renderCsv, renderHtml, renderMarkdown } from "../evals/src/report";
import { resolveWaitingInteraction } from "../evals/src/runner";
import { EvalExperimentSummary, EvalResult } from "../evals/src/types";

const now = "2026-07-27T00:00:00.000Z";

function message(activityId: string, body: string): Activity {
  return {
    activityId,
    audience: "user",
    body,
    kind: "message",
    runId: "run_eval",
    startedAt: now,
    status: "completed"
  };
}

function readActivity(): Activity {
  return {
    activityId: "activity_read",
    audience: "user",
    body: "",
    kind: "tool",
    runId: "run_eval",
    startedAt: now,
    status: "completed",
    tool: {
      action: "inspect",
      argumentsPreview: "shared/projections/displaySegments.ts",
      callId: "call_read",
      effect: "read_only",
      modelStepId: "step_read",
      normalizedTarget: "shared/projections/displaySegments.ts",
      targetKind: "file",
      toolName: "read_file"
    }
  };
}

function runWithContent(content: string[]): Run {
  const answer = "已完成分析。";
  const activities = [message("activity_frame", content[0]), readActivity()];
  if (content[1]) activities.push(message("activity_analysis", content[1]));
  activities.push(message("activity_final", answer));
  return {
    activities,
    answer,
    approvals: [],
    changes: emptyChanges(),
    finishedAt: now,
    lastOffset: 4,
    mode: "work",
    model: "test",
    prompt: "解释展示状态",
    runId: "run_eval",
    sessionId: "session_eval",
    startedAt: now,
    status: "completed",
    tasks: []
  };
}

function activityEvent(activityId: string, eventId: string, offset: number): Event<"activity.finished"> {
  return {
    at: now,
    data: { finishedAt: now, status: "completed" },
    eventId,
    offset,
    scope: { activityId, runId: "run_eval", sessionId: "session_eval" },
    type: "activity.finished",
    version: EVENT_VERSION
  };
}

test("Eval dataset exposes twenty runnable cases with thirty outcome points each", () => {
  const dataset = loadDataset();
  assert.equal(dataset.dataset.status, "runnable");
  assert.equal(dataset.cases.length, 20);
  assert.equal(new Set(dataset.cases.map((item) => item.caseId)).size, 20);
  const ready = dataset.cases.filter((item) => item.fixture.status === "ready");
  assert.equal(ready.length, 20);
  assert.equal(new Set(ready.map((item) => item.scenario)).size, 8);
  for (const caseId of ready.map((item) => item.caseId)) {
    const fixture = loadFixture(caseId);
    assert.equal(fixture.assertions.reduce((total, assertion) => total + assertion.points, 0), 30);
  }
});

test("Eval Runner automatically approves a proposed plan without Fixture configuration", async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), url: String(input) });
    return new Response(JSON.stringify({ session: {} }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const resolved = await resolveWaitingInteraction("http://runtime", {
      plans: [{ planId: "plan_1", revision: 2, runId: "run_1", status: "proposed" }],
      questions: [],
      runs: [{ runId: "run_1", status: "waiting" }],
      sessionId: "session_1"
    } as unknown as Session, undefined);
    assert.equal(resolved, true);
    assert.match(requests[0].url, /plans\/plan_1\/revisions\/2\/resolve$/);
    assert.deepEqual(requests[0].body, { accessMode: "full_access", decision: "start_work" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Eval Runner requests one plan revision before approving the replacement", async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), url: String(input) });
    return new Response(JSON.stringify({ session: {} }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const base = {
      questions: [],
      runs: [{ runId: "run_1", status: "waiting" }],
      sessionId: "session_1"
    };
    await resolveWaitingInteraction("http://runtime", {
      ...base,
      plans: [{ planId: "plan_1", revision: 1, runId: "run_1", status: "proposed" }]
    } as unknown as Session, { continuePlanningOnce: "补充重启恢复方案。" });
    assert.deepEqual(requests[0].body, { comments: "补充重启恢复方案。", decision: "continue_planning" });

    await resolveWaitingInteraction("http://runtime", {
      ...base,
      plans: [
        { planId: "plan_1", revision: 1, runId: "run_1", status: "rejected" },
        { planId: "plan_1", revision: 2, runId: "run_1", status: "proposed" }
      ]
    } as unknown as Session, { continuePlanningOnce: "补充重启恢复方案。" });
    assert.deepEqual(requests[1].body, { accessMode: "full_access", decision: "start_work" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Eval Runner answers diagnosis-only questions without authorizing a mutation", async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), url: String(input) });
    return new Response(JSON.stringify({ session: {} }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const resolved = await resolveWaitingInteraction("http://runtime", {
      plans: [],
      questions: [{
        interactionId: "question_1",
        prompts: [{ label: "下一步", options: ["升级依赖", "暂不修改，仅保留诊断"], prompt: "请选择", questionId: "next" }],
        runId: "run_1",
        status: "pending"
      }],
      runs: [{ runId: "run_1", status: "waiting" }],
      sessionId: "session_1"
    } as unknown as Session, { answerQuestions: "diagnosis_only" });
    assert.equal(resolved, true);
    assert.match(requests[0].url, /questions\/question_1\/answer$/);
    assert.deepEqual(requests[0].body, { answers: { next: "暂不修改，仅保留诊断" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Heuristic Content Judge rewards grounded analysis over generic progress placeholders", async () => {
  const dataset = loadDataset();
  const evalCase = findCase(dataset, "CAE-001");
  const judge = new HeuristicContentJudge();
  const events = [
    activityEvent("activity_frame", "event_frame", 1),
    activityEvent("activity_read", "event_read", 2),
    activityEvent("activity_analysis", "event_analysis", 3),
    activityEvent("activity_final", "event_final", 4)
  ];
  const strong = await judge.evaluate({
    evalCase,
    events,
    run: runWithContent([
      "我会从事件事实、展示投影和槽位边界三条主线核对；重点判断这是状态错误还是有意的视觉保持，这一轮只解释，不修改代码。",
      "displaySegments.ts 在工具完成后保留逻辑空槽位的旧标签，说明 Runtime 终态没有丢失，问题属于展示投影的视觉保持。下一步应核对新 Content 到来时的 segment 边界，而不是修改工具状态。"
    ])
  });
  const weak = await judge.evaluate({
    evalCase,
    events,
    run: runWithContent(["我先看看。", "获取到了有用的信息，让我继续分析。"])
  });
  assert.ok(strong.scores.total > weak.scores.total);
  assert.equal(weak.metrics.genericPlaceholderCount, 2);
  assert.ok(strong.metrics.substantiveContentRate > weak.metrics.substantiveContentRate);
});

function sampleResult(): EvalResult {
  return {
    assertionResults: [],
    attempt: 1,
    attribution: { evidenceEventIds: [], failureCodes: [], primaryLayer: "none", secondaryLayers: [], summary: "通过" },
    caseId: "CAE-001",
    finishedAt: now,
    hardFailures: [],
    judgeFindings: [],
    metrics: {
      durationMs: 1_000,
      factInterpretationLinkRate: 1,
      genericPlaceholderCount: 0,
      groundedAnalysisRate: 1,
      groundedClaimRate: 1,
      prematureCompletionCount: 0,
      redundantProgressCount: 0,
      substantiveContentRate: 1,
      toolCallCount: 2,
      toolPrecision: 1,
      userInterventionCount: 0,
      verificationCompleted: true
    },
    model: "test-model",
    passed: true,
    promptVersion: "prompt-v1",
    runId: "run_eval",
    scores: {
      efficiency: 5,
      processContent: { analysisAndJudgment: 7, evidenceGrounding: 7, logicalProgression: 6, total: 25, userValue: 5 },
      safety: 10,
      taskOutcome: 30,
      toolTrajectory: 15,
      total: 100,
      verification: 15
    },
    sessionId: "session_eval",
    startedAt: now
  };
}

test("Eval reports render readable Markdown, HTML, and CSV score tables", () => {
  const summary: EvalExperimentSummary = { experimentId: "experiment-test", generatedAt: now, results: [sampleResult()] };
  assert.match(renderMarkdown(summary), /总体成绩/);
  assert.match(renderMarkdown(summary), /事实与证据/);
  assert.match(renderHtml(summary), /Agent Eval Report/);
  assert.match(renderHtml(summary), /过程 Content/);
  assert.match(renderCsv(summary.results), /groundedAnalysisRate/);
});
