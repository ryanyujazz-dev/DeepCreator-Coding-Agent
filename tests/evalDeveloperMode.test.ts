import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startRuntime } from "../server/bootstrap/runtime";
import { EvalService, loadPersistedEvalRuns, loadPersistedEvalSession } from "../server/dev-evals/evalService";
import { completedEvalRunsByCase, isEvalRunActive } from "../src/components/evals/evalSidebarProjection";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("development server ignores evaluation workspaces and generated reports", () => {
  const source = readFileSync(path.join(repositoryRoot, "vite.config.ts"), "utf8");
  assert.match(source, /ignored:\s*\["\*\*\/\.eval-worktrees\/\*\*", "\*\*\/evals\/runs\/\*\*"\]/);
});

test("keeps active attempts in the dataset and archives only finished attempts as results", () => {
  const activeRun = {
    attempt: 2,
    caseId: "CAE-001",
    createdAt: "2026-07-27T11:00:00.000Z",
    evalRunId: "evalrun_active",
    experimentId: "developer-ui-2026-07-27",
    judge: "heuristic" as const,
    model: "mock-agent",
    promptVersion: "current",
    stage: "running_agent" as const
  };
  const finishedRun = {
    ...activeRun,
    attempt: 1,
    createdAt: "2026-07-27T10:00:00.000Z",
    evalRunId: "evalrun_finished",
    finishedAt: "2026-07-27T10:01:00.000Z",
    stage: "completed" as const
  };
  const groupedResults = completedEvalRunsByCase([activeRun, finishedRun]);

  assert.equal(isEvalRunActive(activeRun), true);
  assert.deepEqual(groupedResults.get("CAE-001")?.map((run) => run.evalRunId), ["evalrun_finished"]);
});

test("restores every developer UI attempt from persisted evaluation results", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-eval-history-"));
  try {
    const firstAttempt = path.join(root, "evals/runs/developer-ui-2026-07-27/CAE-001/attempt-01");
    const secondAttempt = path.join(root, "evals/runs/developer-ui-2026-07-27/CAE-001/attempt-02");
    const ignoredAttempt = path.join(root, "evals/runs/smoke/CAE-001/attempt-01");
    const result = {
      assertionResults: [],
      attempt: 1,
      attribution: { failureCodes: [], primaryLayer: "none", secondaryLayers: [], summary: "" },
      caseId: "CAE-001",
      finishedAt: "2026-07-27T10:01:00.000Z",
      hardFailures: [],
      judgeFindings: [],
      metrics: { durationMs: 60_000, genericPlaceholderCount: 0, groundedAnalysisRate: 1, groundedClaimRate: 1, redundantProgressCount: 0, substantiveContentRate: 1, toolCallCount: 1, toolPrecision: 1, verificationCompleted: true },
      model: "mock-agent",
      passed: true,
      promptVersion: "current",
      runId: "run_01",
      scores: { efficiency: 5, processContent: { analysisAndJudgment: 7, evidenceGrounding: 7, logicalProgression: 6, total: 25, userValue: 5 }, safety: 10, taskOutcome: 30, toolTrajectory: 15, total: 100, verification: 15 },
      sessionId: "eval_CAE_001_01",
      startedAt: "2026-07-27T10:00:00.000Z"
    };
    for (const directory of [firstAttempt, secondAttempt, ignoredAttempt]) mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(firstAttempt, "result.json"), JSON.stringify(result), "utf8");
    writeFileSync(path.join(firstAttempt, "trace.jsonl"), [
      { at: result.startedAt, data: { compactThresholdTokens: 80_000, contextWindowTokens: 100_000, createdAt: result.startedAt, model: result.model, projectRoot: "/fixture", sessionId: result.sessionId, title: "历史评测任务" }, eventId: `${result.sessionId}:1`, offset: 1, scope: { sessionId: result.sessionId }, type: "session.created", version: "deepcreator.events/v2" },
      { at: result.startedAt, data: { model: result.model, prompt: "解释历史问题", startedAt: result.startedAt }, eventId: `${result.sessionId}:2`, offset: 2, scope: { runId: result.runId, sessionId: result.sessionId }, type: "run.started", version: "deepcreator.events/v2" },
      { at: result.finishedAt, data: { answer: "基于历史事实的结论", finishedAt: result.finishedAt, status: "completed" }, eventId: `${result.sessionId}:3`, offset: 3, scope: { runId: result.runId, sessionId: result.sessionId }, type: "run.finished", version: "deepcreator.events/v2" }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    writeFileSync(path.join(secondAttempt, "result.json"), JSON.stringify({ ...result, attempt: 2, finishedAt: "2026-07-27T11:01:00.000Z", runId: "run_02", sessionId: "eval_CAE_001_02", startedAt: "2026-07-27T11:00:00.000Z" }), "utf8");
    writeFileSync(path.join(secondAttempt, "eval-run.json"), JSON.stringify({ attempt: 2, caseId: "CAE-001", createdAt: "2026-07-27T11:00:00.000Z", evalRunId: "evalrun_02", experimentId: "developer-ui-2026-07-27", finishedAt: "2026-07-27T11:01:00.000Z", judge: "provider", judgeModel: "judge-model", model: "mock-agent", promptVersion: "current", runId: "run_02", sessionId: "eval_CAE_001_02", stage: "completed" }), "utf8");
    writeFileSync(path.join(ignoredAttempt, "result.json"), JSON.stringify(result), "utf8");

    const restored = loadPersistedEvalRuns(root);
    assert.equal(restored.length, 2);
    assert.deepEqual(restored.map((run) => run.attempt), [2, 1]);
    assert.equal(restored[0].evalRunId, "evalrun_02");
    assert.equal(restored[0].judge, "provider");
    assert.equal(restored[0].result?.scores.total, 100);
    assert.equal(restored[1].sessionId, "eval_CAE_001_01");
    const restoredSession = loadPersistedEvalSession(root, restored[1]);
    assert.equal(restoredSession?.title, "历史评测任务");
    assert.equal(restoredSession?.runs[0].answer, "基于历史事实的结论");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("registers evaluation APIs only when developer evaluation mode is enabled", async () => {
  const disabledData = mkdtempSync(path.join(tmpdir(), "deepcreator-evals-disabled-"));
  const enabledData = mkdtempSync(path.join(tmpdir(), "deepcreator-evals-enabled-"));
  const disabled = await startRuntime({
    dataDirectory: disabledData,
    runtimeMode: "mock",
    workspaceRoot: repositoryRoot
  });
  try {
    const baseUrl = `http://${disabled.host}:${disabled.port}`;
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as { evalsEnabled: boolean };
    assert.equal(config.evalsEnabled, false);
    assert.equal((await fetch(`${baseUrl}/api/evals/cases`)).status, 404);
  } finally {
    await disabled.close();
    rmSync(disabledData, { force: true, recursive: true });
  }

  const enabled = await startRuntime({
    dataDirectory: enabledData,
    evalRepositoryRoot: repositoryRoot,
    evalServiceFactory: async (deps) => new EvalService(deps),
    runtimeMode: "mock",
    workspaceRoot: repositoryRoot
  });
  try {
    const baseUrl = `http://${enabled.host}:${enabled.port}`;
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as { evalsEnabled: boolean };
    const cases = await fetch(`${baseUrl}/api/evals/cases`).then((response) => response.json()) as { cases: Array<{ status: string }> };
    assert.equal(config.evalsEnabled, true);
    assert.equal(cases.cases.length, 20);
    assert.equal(cases.cases.filter((item) => item.status === "ready").length, 8);
  } finally {
    await enabled.close();
    rmSync(enabledData, { force: true, recursive: true });
  }
});
