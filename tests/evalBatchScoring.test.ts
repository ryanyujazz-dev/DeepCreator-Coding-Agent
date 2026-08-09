import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EVAL_JUDGE, DEFAULT_EVAL_JUDGE_MODEL, EvalBatchCaseRecord, EvalRunRecord } from "../shared/contracts/evals";
import { evalBatchSchedulingEnabled, evalDifficultyWeight, selectQueuedEvalRuns, summarizeEvalBatch } from "../shared/domain/evalBatchScoring";

function batchCase(caseId: string, difficulty: "easy" | "medium" | "hard", evalRunId: string): EvalBatchCaseRecord {
  return { caseId, difficulty, evalRunId, weight: evalDifficultyWeight(difficulty) };
}

function run(evalRunId: string, stage: EvalRunRecord["stage"], score?: number, passed = false): EvalRunRecord {
  return {
    attempt: 1,
    caseId: evalRunId,
    createdAt: "2026-08-01T00:00:00.000Z",
    evalRunId,
    experimentId: "developer-ui-2026-08-01",
    judge: "heuristic",
    model: "mock-agent",
    promptVersion: "current",
    result: score === undefined ? undefined : {
      assertionResults: [],
      attribution: { failureCodes: [], primaryLayer: "none", secondaryLayers: [], summary: "" },
      hardFailures: [],
      judgeFindings: [],
      metrics: { durationMs: 1, genericPlaceholderCount: 0, groundedAnalysisRate: 1, groundedClaimRate: 1, redundantProgressCount: 0, substantiveContentRate: 1, toolCallCount: 0, toolPrecision: 1, verificationCompleted: true },
      passed,
      scores: { efficiency: 0, processContent: { analysisAndJudgment: 0, evidenceGrounding: 0, logicalProgression: 0, total: 0, userValue: 0 }, safety: 0, taskOutcome: 0, toolTrajectory: 0, total: score, verification: 0 }
    },
    stage
  };
}

test("calculates a difficulty-weighted full evaluation average", () => {
  const cases = [
    batchCase("CAE-001", "easy", "run_easy"),
    batchCase("CAE-002", "medium", "run_medium"),
    batchCase("CAE-003", "hard", "run_hard")
  ];
  const summary = summarizeEvalBatch(cases, [
    run("run_easy", "completed", 100, true),
    run("run_medium", "completed", 80, true),
    run("run_hard", "completed", 60, false)
  ]);

  assert.deepEqual(summary, { completedCases: 3, failedCases: 1, passedCases: 2, weightedAverage: 75.6 });
});

test("keeps failed and cancelled cases in the full evaluation denominator", () => {
  const cases = [
    batchCase("CAE-001", "easy", "run_success"),
    batchCase("CAE-002", "hard", "run_failed"),
    batchCase("CAE-003", "medium", "run_cancelled")
  ];
  const summary = summarizeEvalBatch(cases, [
    run("run_success", "completed", 90, true),
    run("run_failed", "failed"),
    run("run_cancelled", "cancelled")
  ]);

  assert.deepEqual(summary, { completedCases: 3, failedCases: 2, passedCases: 1, weightedAverage: 20 });
});

test("withholds the weighted score until every case reaches a terminal stage", () => {
  const cases = [batchCase("CAE-001", "easy", "run_done"), batchCase("CAE-002", "medium", "run_queued")];
  assert.deepEqual(summarizeEvalBatch(cases, [run("run_done", "completed", 100, true), run("run_queued", "queued")]), {
    completedCases: 1,
    failedCases: 0,
    passedCases: 1,
    weightedAverage: undefined
  });
});

test("fills available batch concurrency slots in dataset order", () => {
  const cases = [
    batchCase("CAE-001", "easy", "run_active"),
    batchCase("CAE-002", "medium", "run_second"),
    batchCase("CAE-003", "hard", "run_third")
  ];
  const runs = [run("run_active", "running_agent"), run("run_second", "queued"), run("run_third", "queued")];

  assert.deepEqual(selectQueuedEvalRuns(cases, runs, 2).map((item) => item.evalRunId), ["run_second"]);
  runs[0].stage = "completed";
  assert.deepEqual(selectQueuedEvalRuns(cases, runs, 2).map((item) => item.evalRunId), ["run_second", "run_third"]);
});

test("pauses queue scheduling without changing the default LLM judge", () => {
  assert.equal(evalBatchSchedulingEnabled("running"), true);
  assert.equal(evalBatchSchedulingEnabled("paused"), false);
  assert.equal(DEFAULT_EVAL_JUDGE, "provider");
  assert.equal(DEFAULT_EVAL_JUDGE_MODEL, "deepseek-v4-flash");
});
