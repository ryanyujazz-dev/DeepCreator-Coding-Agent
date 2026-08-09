export type EvalScenario =
  | "code_explanation"
  | "bug_fix"
  | "feature_implementation"
  | "test_completion"
  | "refactor_optimization"
  | "documentation"
  | "data_processing"
  | "environment_dependency";

export const DEFAULT_EVAL_JUDGE = "provider" as const;
export const DEFAULT_EVAL_JUDGE_MODEL = "deepseek-v4-flash";

export type EvalCaseSummary = {
  allowedTools: string[];
  caseId: string;
  difficulty: "easy" | "medium" | "hard";
  idealStepCount: number;
  initialMode: "work" | "plan";
  riskLevel: "low" | "medium" | "high";
  scenario: EvalScenario;
  status: "planned" | "ready";
  title: string;
  userRequest: string;
};

export type EvalProcessContentScores = {
  analysisAndJudgment: number;
  evidenceGrounding: number;
  logicalProgression: number;
  total: number;
  userValue: number;
};

export type EvalResultView = {
  assertionResults: Array<{
    assertionId: string;
    detail: string;
    kind: string;
    passed: boolean;
    pointsAwarded: number;
    pointsAvailable: number;
  }>;
  attribution: {
    failureCodes: string[];
    primaryLayer: "none" | "model" | "tool" | "context" | "interaction" | "feedback";
    secondaryLayers: string[];
    summary: string;
  };
  hardFailures: Array<{ detail: string; evidenceEventIds: string[]; rule: string }>;
  judgeFindings: Array<{
    confidence: number;
    dimension: string;
    evidenceEventIds: string[];
    reason: string;
    score: number;
  }>;
  metrics: {
    durationMs: number;
    genericPlaceholderCount: number;
    groundedAnalysisRate: number;
    groundedClaimRate: number;
    redundantProgressCount: number;
    substantiveContentRate: number;
    toolCallCount: number;
    toolPrecision: number;
    verificationCompleted: boolean;
  };
  passed: boolean;
  scores: {
    efficiency: number;
    processContent: EvalProcessContentScores;
    safety: number;
    taskOutcome: number;
    toolTrajectory: number;
    total: number;
    verification: number;
  };
};

export type EvalRunStage =
  | "queued"
  | "preparing"
  | "running_agent"
  | "verifying"
  | "judging"
  | "completed"
  | "failed"
  | "cancelled";

export type EvalRunRecord = {
  attempt: number;
  batchId?: string;
  caseId: string;
  createdAt: string;
  error?: string;
  evalRunId: string;
  experimentId: string;
  finishedAt?: string;
  judge: "heuristic" | "provider";
  judgeModel?: string;
  model: string;
  promptVersion: string;
  result?: EvalResultView;
  runId?: string;
  sessionId?: string;
  stage: EvalRunStage;
};

export type EvalBatchCaseRecord = {
  caseId: string;
  difficulty: EvalCaseSummary["difficulty"];
  evalRunId: string;
  weight: number;
};

export type EvalBatchRunRecord = {
  batchId: string;
  cases: EvalBatchCaseRecord[];
  completedCases: number;
  concurrency: number;
  createdAt: string;
  error?: string;
  experimentId: string;
  failedCases: number;
  finishedAt?: string;
  judge: "heuristic" | "provider";
  judgeModel?: string;
  model: string;
  passedCases: number;
  promptVersion: string;
  stage: "running" | "paused" | "completed" | "failed";
  weightedAverage?: number;
};

export type EvalCasesResponse = { cases: EvalCaseSummary[] };
export type EvalRunsResponse = { runs: EvalRunRecord[] };
export type EvalRunResponse = { run: EvalRunRecord };
export type EvalBatchesResponse = { batches: EvalBatchRunRecord[] };
export type EvalBatchResponse = { batch: EvalBatchRunRecord };

export type StartEvalRunInput = {
  caseId: string;
  judge?: "heuristic" | "provider";
  judgeModel?: string;
  model: string;
  promptVersion?: string;
};

export type StartEvalBatchInput = Omit<StartEvalRunInput, "caseId">;
