import assert from "node:assert/strict";
import test from "node:test";
import { Activity, emptyChanges, EVENT_VERSION, Event, Run } from "../shared/contracts/runtime";
import { HeuristicContentJudge } from "../evals/src/contentJudge";
import { findCase, loadDataset, loadFixture } from "../evals/src/dataset";
import { renderCsv, renderHtml, renderMarkdown } from "../evals/src/report";
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

test("Eval dataset exposes twenty unique cases and ready fixtures total thirty outcome points", () => {
  const dataset = loadDataset();
  assert.equal(dataset.cases.length, 20);
  assert.equal(new Set(dataset.cases.map((item) => item.caseId)).size, 20);
  assert.equal(findCase(dataset, "CAE-003").fixture.status, "ready");
  for (const caseId of ["CAE-001", "CAE-003"]) {
    const fixture = loadFixture(caseId);
    assert.equal(fixture.assertions.reduce((total, assertion) => total + assertion.points, 0), 30);
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
