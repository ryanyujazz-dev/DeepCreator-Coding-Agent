import { Event, Run } from "../../shared/contracts/runtime";

export type EvalScenario =
  | "code_explanation"
  | "bug_fix"
  | "feature_implementation"
  | "test_completion"
  | "refactor_optimization"
  | "documentation"
  | "data_processing"
  | "environment_dependency";

export type EvalCase = {
  caseId: string;
  title: string;
  scenario: EvalScenario;
  difficulty: "easy" | "medium" | "hard";
  riskLevel: "low" | "medium" | "high";
  fixture: { id: string; status: "planned" | "ready"; description: string };
  userRequest: string;
  modeExpectation: {
    initialMode: "work" | "plan";
    planBehavior: "not_required" | "recommended" | "required";
    userConfirmation: "not_required" | "required_before_mutation" | "required_for_ambiguity";
  };
  tools: { allowed: string[]; forbidden: string[]; expected: string[] };
  idealTrajectory: Array<{ intent: string; observableOutcome: string }>;
  contentEvaluation: {
    checkpoints: Array<{
      stage: "before_tools" | "after_investigation" | "before_mutation" | "before_verification" | "final";
      purpose: string;
      mustInclude: string[];
      mustAvoid: string[];
    }>;
    groundedFacts: string[];
    forbiddenClaims: string[];
  };
  successCriteria: Array<{
    criterionId: string;
    evaluator: "deterministic" | "trace_rule" | "llm_judge";
    assertion: string;
  }>;
  failureModes: Array<{
    code: string;
    layer: AttributionLayer;
    severity: "minor" | "major" | "critical";
    description: string;
  }>;
  tags: string[];
};

export type EvalDataset = {
  dataset: {
    id: string;
    version: string;
    language: "zh-CN";
    caseCount: number;
    status: "spec_only" | "runnable" | "released";
  };
  scoring: {
    passScore: number;
    dimensions: {
      taskOutcome: number;
      processContent: number;
      toolTrajectory: number;
      verification: number;
      safety: number;
      efficiency: number;
    };
    hardFailRules: string[];
  };
  cases: EvalCase[];
};

export type FixtureAssertion =
  | { id: string; kind: "command"; command: string; expectedExitCode: number; points: number }
  | { id: string; kind: "file_contains"; path: string; text: string; points: number }
  | { id: string; kind: "file_not_contains"; path: string; text: string; points: number }
  | { id: string; kind: "git_diff_empty"; points: number }
  | { id: string; kind: "git_diff_excludes"; paths: string[]; points: number }
  | { id: string; kind: "run_answer_contains"; text: string; points: number }
  | { id: string; kind: "run_completed"; points: number };

export type EvalFixtureManifest = {
  caseId: string;
  status: "planned" | "ready";
  base: { kind: "git"; revision: string };
  setupPatch?: string;
  interactions?: {
    autoApprovePlan?: boolean;
    answerQuestions?: "first_option" | "diagnosis_only";
  };
  assertions: FixtureAssertion[];
  timeoutMs?: number;
};

export type AssertionResult = {
  assertionId: string;
  kind: FixtureAssertion["kind"];
  passed: boolean;
  pointsAwarded: number;
  pointsAvailable: number;
  detail: string;
};

export type ProcessContentScores = {
  evidenceGrounding: number;
  analysisAndJudgment: number;
  logicalProgression: number;
  userValue: number;
  total: number;
};

export type JudgeFinding = {
  dimension: string;
  score: number;
  reason: string;
  evidenceEventIds: string[];
  confidence: number;
};

export type ContentJudgeResult = {
  scores: ProcessContentScores;
  findings: JudgeFinding[];
  metrics: {
    groundedClaimRate: number;
    substantiveContentRate: number;
    groundedAnalysisRate: number;
    factInterpretationLinkRate: number;
    genericPlaceholderCount: number;
    redundantProgressCount: number;
  };
};

export type AttributionLayer = "model" | "tool" | "context" | "interaction" | "feedback";

export type HardFailure = {
  rule: string;
  evidenceEventIds: string[];
  detail: string;
};

export type EvalResult = {
  caseId: string;
  runId: string;
  sessionId: string;
  model: string;
  promptVersion: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  scores: {
    taskOutcome: number;
    processContent: ProcessContentScores;
    toolTrajectory: number;
    verification: number;
    safety: number;
    efficiency: number;
    total: number;
  };
  hardFailures: HardFailure[];
  metrics: ContentJudgeResult["metrics"] & {
    prematureCompletionCount: number;
    toolPrecision: number;
    verificationCompleted: boolean;
    userInterventionCount: number;
    toolCallCount: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs: number;
  };
  assertionResults: AssertionResult[];
  judgeFindings: JudgeFinding[];
  attribution: {
    primaryLayer: "none" | AttributionLayer;
    secondaryLayers: AttributionLayer[];
    failureCodes: string[];
    evidenceEventIds: string[];
    summary: string;
  };
  passed: boolean;
};

export type EvalTrace = {
  caseId: string;
  sessionId: string;
  run: Run;
  events: Event[];
};

export type EvalExperimentSummary = {
  experimentId: string;
  generatedAt: string;
  results: EvalResult[];
};
