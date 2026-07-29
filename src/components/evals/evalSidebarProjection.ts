import { EvalRunRecord } from "../../../shared/contracts/evals";

export function latestEvalRunsByCase(runs: EvalRunRecord[]): Map<string, EvalRunRecord> {
  const result = new Map<string, EvalRunRecord>();
  for (const run of runs) if (!result.has(run.caseId)) result.set(run.caseId, run);
  return result;
}

export function completedEvalRunsByCase(runs: EvalRunRecord[]): Map<string, EvalRunRecord[]> {
  const result = new Map<string, EvalRunRecord[]>();
  for (const run of runs) {
    if (!run.finishedAt) continue;
    result.set(run.caseId, [...(result.get(run.caseId) ?? []), run]);
  }
  for (const items of result.values()) items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return result;
}

export function isEvalRunActive(run?: EvalRunRecord): boolean {
  return Boolean(run && ["preparing", "running_agent", "verifying", "judging"].includes(run.stage));
}
