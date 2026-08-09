import { EvalCaseSummary, EvalRunRecord, EvalScenario } from "../../../shared/contracts/evals";

export type EvalScenarioGroup = {
  cases: EvalCaseSummary[];
  label: string;
  scenario: EvalScenario;
};

export const EVAL_SCENARIO_GROUPS: ReadonlyArray<Omit<EvalScenarioGroup, "cases">> = [
  { label: "代码解释", scenario: "code_explanation" },
  { label: "Bug 修复", scenario: "bug_fix" },
  { label: "功能实现", scenario: "feature_implementation" },
  { label: "测试补全", scenario: "test_completion" },
  { label: "重构优化", scenario: "refactor_optimization" },
  { label: "文档生成", scenario: "documentation" },
  { label: "数据处理", scenario: "data_processing" },
  { label: "环境与依赖排查", scenario: "environment_dependency" }
];

export function evalScenarioLabel(scenario: EvalScenario): string {
  return EVAL_SCENARIO_GROUPS.find((group) => group.scenario === scenario)?.label ?? scenario;
}

export function groupEvalCasesByScenario(cases: EvalCaseSummary[]): EvalScenarioGroup[] {
  const casesByScenario = new Map<EvalScenario, EvalCaseSummary[]>();
  for (const item of cases) {
    casesByScenario.set(item.scenario, [...(casesByScenario.get(item.scenario) ?? []), item]);
  }
  return EVAL_SCENARIO_GROUPS.flatMap((group) => {
    const groupedCases = casesByScenario.get(group.scenario) ?? [];
    return groupedCases.length > 0 ? [{ ...group, cases: groupedCases }] : [];
  });
}

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

export function completedSingleEvalRunsByCase(runs: EvalRunRecord[]): Map<string, EvalRunRecord[]> {
  return completedEvalRunsByCase(runs.filter((run) => !run.batchId));
}

export function isEvalRunActive(run?: EvalRunRecord): boolean {
  return Boolean(run && ["queued", "preparing", "running_agent", "verifying", "judging"].includes(run.stage));
}
