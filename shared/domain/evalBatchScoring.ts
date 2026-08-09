import {
  EvalBatchCaseRecord,
  EvalCaseSummary,
  EvalRunRecord
} from "../contracts/evals";

export const EVAL_DIFFICULTY_WEIGHTS: Record<EvalCaseSummary["difficulty"], number> = {
  easy: 1,
  hard: 2,
  medium: 1.5
};

export type EvalBatchSummary = {
  completedCases: number;
  failedCases: number;
  passedCases: number;
  weightedAverage?: number;
};

export function evalDifficultyWeight(difficulty: EvalCaseSummary["difficulty"]): number {
  return EVAL_DIFFICULTY_WEIGHTS[difficulty];
}

export function evalBatchSchedulingEnabled(stage: "running" | "paused" | "completed" | "failed"): boolean {
  return stage === "running";
}

const ACTIVE_BATCH_RUN_STAGES = new Set<EvalRunRecord["stage"]>([
  "preparing",
  "running_agent",
  "verifying",
  "judging"
]);

export function selectQueuedEvalRuns(
  cases: EvalBatchCaseRecord[],
  runs: EvalRunRecord[],
  concurrency: number
): EvalRunRecord[] {
  const runsById = new Map(runs.map((run) => [run.evalRunId, run]));
  const activeCount = cases.reduce((total, item) => {
    const stage = runsById.get(item.evalRunId)?.stage;
    return total + (stage && ACTIVE_BATCH_RUN_STAGES.has(stage) ? 1 : 0);
  }, 0);
  const available = Math.max(0, Math.floor(concurrency) - activeCount);
  return cases
    .flatMap((item) => {
      const run = runsById.get(item.evalRunId);
      return run?.stage === "queued" ? [run] : [];
    })
    .slice(0, available);
}

export function summarizeEvalBatch(cases: EvalBatchCaseRecord[], runs: EvalRunRecord[]): EvalBatchSummary {
  const runsById = new Map(runs.map((run) => [run.evalRunId, run]));
  const terminalRuns = cases.flatMap((item) => {
    const run = runsById.get(item.evalRunId);
    return run && ["cancelled", "completed", "failed"].includes(run.stage) ? [run] : [];
  });
  const passedCases = terminalRuns.filter((run) => run.result?.passed === true).length;
  const complete = terminalRuns.length === cases.length;
  const totalWeight = cases.reduce((total, item) => total + item.weight, 0);
  const weightedPoints = cases.reduce((total, item) => {
    const run = runsById.get(item.evalRunId);
    const score = run?.stage === "completed" ? run.result?.scores.total ?? 0 : 0;
    return total + score * item.weight;
  }, 0);
  return {
    completedCases: terminalRuns.length,
    failedCases: terminalRuns.length - passedCases,
    passedCases,
    weightedAverage: complete && totalWeight > 0 ? Math.round(weightedPoints / totalWeight * 10) / 10 : undefined
  };
}
