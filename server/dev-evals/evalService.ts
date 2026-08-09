import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_EVAL_JUDGE,
  DEFAULT_EVAL_JUDGE_MODEL,
  EvalBatchRunRecord,
  EvalCaseSummary,
  EvalResultView,
  EvalRunRecord,
  StartEvalBatchInput,
  StartEvalRunInput
} from "../../shared/contracts/evals";
import { evalBatchSchedulingEnabled, evalDifficultyWeight, selectQueuedEvalRuns, summarizeEvalBatch } from "../../shared/domain/evalBatchScoring";
import { resolveEvalPlanInteraction } from "../../shared/domain/evalInteractionPolicy";
import { Event, isRunDone, QuestionPrompt, Session } from "../../shared/contracts/runtime";
import { rebuildSession } from "../../shared/domain/reducer";
import { answerQuestion, resolvePlan } from "../app/planReview";
import { RunLaunchPort } from "../app/runLauncher";
import { StartRun } from "../app/startRun";
import { ContextPort, EventPort, SessionPort } from "../app/runtimeRepo";
import { SystemPort } from "../app/systemPort";
import { quoteRuntimeShellArgument } from "../infra/shell";
import { runShell } from "../infra/tools/shellExecution";

type DatasetCase = {
  caseId: string;
  difficulty: EvalCaseSummary["difficulty"];
  fixture: { status: EvalCaseSummary["status"] };
  idealTrajectory: unknown[];
  modeExpectation: { initialMode: EvalCaseSummary["initialMode"] };
  riskLevel: EvalCaseSummary["riskLevel"];
  scenario: EvalCaseSummary["scenario"];
  title: string;
  tools: { allowed: string[] };
  userRequest: string;
};

type DatasetFile = { cases: DatasetCase[] };
type FixtureInteractions = {
  answerQuestions?: "first_option" | "diagnosis_only";
  autoApprovePlan?: boolean;
  continuePlanningOnce?: string;
};
type FixtureFile = {
  base: { revision: string };
  interactions?: FixtureInteractions;
  setupPatch?: string;
  status: "planned" | "ready";
};
type PersistedEvalResult = EvalResultView & {
  attempt: number;
  caseId: string;
  finishedAt: string;
  model: string;
  promptVersion: string;
  runId: string;
  sessionId: string;
  startedAt: string;
};

const ACTIVE_STAGES = new Set<EvalRunRecord["stage"]>(["queued", "preparing", "running_agent", "verifying", "judging"]);
const BATCH_CONCURRENCY = 4;

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`路径标识包含非法字符：${value}`);
  return value;
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function loadPersistedEvalRuns(repositoryRoot: string, preserveQueuedBatchIds: ReadonlySet<string> = new Set()): EvalRunRecord[] {
  const runsRoot = path.join(repositoryRoot, "evals/runs");
  if (!existsSync(runsRoot)) return [];
  const restored: EvalRunRecord[] = [];
  for (const experiment of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!experiment.isDirectory() || !experiment.name.startsWith("developer-ui-")) continue;
    const experimentRoot = path.join(runsRoot, experiment.name);
    for (const caseEntry of readdirSync(experimentRoot, { withFileTypes: true })) {
      if (!caseEntry.isDirectory()) continue;
      const caseRoot = path.join(experimentRoot, caseEntry.name);
      for (const attemptEntry of readdirSync(caseRoot, { withFileTypes: true })) {
        if (!attemptEntry.isDirectory() || !/^attempt-\d+$/.test(attemptEntry.name)) continue;
        const attemptRoot = path.join(caseRoot, attemptEntry.name);
        const savedJob = readJson<EvalRunRecord>(path.join(attemptRoot, "eval-run.json"));
        const result = readJson<PersistedEvalResult>(path.join(attemptRoot, "result.json"));
        if (savedJob) {
          const preservedQueued = savedJob.stage === "queued"
            && Boolean(savedJob.batchId && preserveQueuedBatchIds.has(savedJob.batchId));
          const activeInterrupted = ACTIVE_STAGES.has(savedJob.stage) && !result && !preservedQueued;
          restored.push({
            ...savedJob,
            error: activeInterrupted ? "Runtime 重启前评测尚未结束，请重新运行该 Case。" : savedJob.error,
            finishedAt: activeInterrupted ? savedJob.finishedAt ?? savedJob.createdAt : result?.finishedAt ?? savedJob.finishedAt,
            result: result ?? savedJob.result,
            stage: activeInterrupted ? "failed" : result ? savedJob.stage === "cancelled" ? "cancelled" : "completed" : savedJob.stage
          });
          continue;
        }
        if (!result) continue;
        restored.push({
          attempt: result.attempt,
          caseId: result.caseId,
          createdAt: result.startedAt,
          evalRunId: `evalhistory_${experiment.name}_${caseEntry.name}_${attemptEntry.name}`,
          experimentId: experiment.name,
          finishedAt: result.finishedAt,
          judge: "heuristic",
          model: result.model,
          promptVersion: result.promptVersion,
          result,
          runId: result.runId,
          sessionId: result.sessionId,
          stage: "completed"
        });
      }
    }
  }
  return restored.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function loadPersistedEvalBatches(repositoryRoot: string): EvalBatchRunRecord[] {
  const runsRoot = path.join(repositoryRoot, "evals/runs");
  if (!existsSync(runsRoot)) return [];
  const restored: EvalBatchRunRecord[] = [];
  for (const experiment of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!experiment.isDirectory() || !experiment.name.startsWith("developer-ui-")) continue;
    const batchesRoot = path.join(runsRoot, experiment.name, "batches");
    if (!existsSync(batchesRoot)) continue;
    for (const entry of readdirSync(batchesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const batch = readJson<EvalBatchRunRecord>(path.join(batchesRoot, entry.name));
      if (batch) restored.push(batch);
    }
  }
  return restored.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function loadPersistedEvalSession(repositoryRoot: string, run: EvalRunRecord): Session | undefined {
  try {
    const attemptName = `attempt-${String(run.attempt).padStart(2, "0")}`;
    const tracePath = path.join(repositoryRoot, "evals/runs", safeSegment(run.experimentId), safeSegment(run.caseId), attemptName, "trace.jsonl");
    if (!existsSync(tracePath)) return undefined;
    const events = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
    return rebuildSession(events);
  } catch {
    return undefined;
  }
}

export class EvalService {
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly batchJobs = new Map<string, EvalBatchRunRecord>();
  private readonly interactionInFlight = new Set<string>();
  private readonly jobs = new Map<string, EvalRunRecord>();
  private readonly shutdownController = new AbortController();
  private readonly unsubscribers = new Map<string, () => void>();
  private shuttingDown = false;
  private worktreeMutation: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    launchRun?: RunLaunchPort;
    repositoryRoot: string;
    startRun: StartRun;
    store: ContextPort & EventPort & SessionPort;
    system?: SystemPort;
  }) {
    const batches = loadPersistedEvalBatches(deps.repositoryRoot);
    const pausedBatchIds = new Set(batches.filter((batch) => batch.stage === "paused").map((batch) => batch.batchId));
    for (const run of loadPersistedEvalRuns(deps.repositoryRoot, pausedBatchIds)) this.jobs.set(run.evalRunId, run);
    for (const batch of batches) this.batchJobs.set(batch.batchId, batch);
    for (const batch of this.batchJobs.values()) this.updateBatch(batch);
  }

  cases(): EvalCaseSummary[] {
    return this.dataset().cases.map((item) => ({
      allowedTools: item.tools.allowed,
      caseId: item.caseId,
      difficulty: item.difficulty,
      idealStepCount: item.idealTrajectory.length,
      initialMode: item.modeExpectation.initialMode,
      riskLevel: item.riskLevel,
      scenario: item.scenario,
      status: item.fixture.status,
      title: item.title,
      userRequest: item.userRequest
    }));
  }

  runs(): EvalRunRecord[] {
    return [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  batches(): EvalBatchRunRecord[] {
    return [...this.batchJobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(evalRunId: string): EvalRunRecord | undefined {
    return this.jobs.get(evalRunId);
  }

  session(evalRunId: string): Session | undefined {
    const job = this.jobs.get(evalRunId);
    if (!job) return undefined;
    const live = job.sessionId ? this.deps.store.getSession(job.sessionId) : undefined;
    return live ?? loadPersistedEvalSession(this.deps.repositoryRoot, job);
  }

  async start(input: StartEvalRunInput): Promise<EvalRunRecord> {
    this.assertCanStart();
    const evalCase = this.dataset().cases.find((item) => item.caseId === input.caseId);
    if (!evalCase) throw new Error(`未找到评测 Case：${input.caseId}`);
    if (evalCase.fixture.status !== "ready") throw new Error(`${input.caseId} 尚未配置可运行 Fixture。`);
    const fixture = this.fixture(input.caseId);
    if (fixture.status !== "ready") throw new Error(`${input.caseId} Fixture 尚未就绪。`);
    const experimentId = `developer-ui-${new Date().toISOString().slice(0, 10)}`;
    const job = this.createJob(input, evalCase, experimentId, "preparing");
    this.startBackground(this.launchJob(job));
    return job;
  }

  async startBatch(input: StartEvalBatchInput): Promise<EvalBatchRunRecord> {
    this.assertCanStart();
    const cases = this.dataset().cases;
    const unavailable = cases.filter((item) => item.fixture.status !== "ready" || this.fixture(item.caseId).status !== "ready");
    if (unavailable.length > 0) throw new Error(`全量评测需要全部 Fixture 就绪：${unavailable.map((item) => item.caseId).join("、")}`);
    if (cases.length === 0) throw new Error("评测集为空，无法启动全量评测。");
    const batchId = `evalbatch_${randomUUID().replaceAll("-", "")}`;
    const experimentId = `developer-ui-${new Date().toISOString().slice(0, 10)}`;
    const judge = input.judge ?? DEFAULT_EVAL_JUDGE;
    const jobs = cases.map((evalCase) => this.createJob(input, evalCase, experimentId, "queued", batchId));
    const batch: EvalBatchRunRecord = {
      batchId,
      cases: jobs.map((job, index) => ({
        caseId: job.caseId,
        difficulty: cases[index].difficulty,
        evalRunId: job.evalRunId,
        weight: evalDifficultyWeight(cases[index].difficulty)
      })),
      completedCases: 0,
      concurrency: BATCH_CONCURRENCY,
      createdAt: new Date().toISOString(),
      experimentId,
      failedCases: 0,
      judge,
      judgeModel: judge === "provider" ? input.judgeModel ?? DEFAULT_EVAL_JUDGE_MODEL : undefined,
      model: input.model,
      passedCases: 0,
      promptVersion: input.promptVersion ?? "current",
      stage: "running"
    };
    this.batchJobs.set(batchId, batch);
    this.persistBatch(batch);
    this.scheduleBatch(batch);
    return batch;
  }

  pauseBatch(batchId: string): EvalBatchRunRecord | undefined {
    const batch = this.batchJobs.get(batchId);
    if (!batch) return undefined;
    if (batch.stage === "running") {
      batch.stage = "paused";
      this.persistBatch(batch);
    }
    return batch;
  }

  resumeBatch(batchId: string): EvalBatchRunRecord | undefined {
    const batch = this.batchJobs.get(batchId);
    if (!batch) return undefined;
    if (batch.stage === "paused") {
      batch.stage = "running";
      this.persistBatch(batch);
      this.scheduleBatch(batch);
    }
    return batch;
  }

  private assertCanStart(): void {
    if (this.shuttingDown) throw new Error("Runtime 正在关闭，无法启动评测。");
    if (this.runs().some((job) => ACTIVE_STAGES.has(job.stage))) {
      throw new Error("当前已有评测正在运行，请等待完成或先停止当前任务。");
    }
  }

  private createJob(
    input: StartEvalBatchInput,
    evalCase: DatasetCase,
    experimentId: string,
    stage: EvalRunRecord["stage"],
    batchId?: string
  ): EvalRunRecord {
    const evalRunId = `evalrun_${randomUUID().replaceAll("-", "")}`;
    const attempt = this.nextAttempt(experimentId, evalCase.caseId);
    const judge = input.judge ?? DEFAULT_EVAL_JUDGE;
    const job: EvalRunRecord = {
      attempt,
      batchId,
      caseId: evalCase.caseId,
      createdAt: new Date().toISOString(),
      evalRunId,
      experimentId,
      judge,
      judgeModel: judge === "provider" ? input.judgeModel ?? DEFAULT_EVAL_JUDGE_MODEL : undefined,
      model: input.model,
      promptVersion: input.promptVersion ?? "current",
      stage
    };
    this.jobs.set(evalRunId, job);
    this.persistJob(job, this.attemptDirectory(job));
    return job;
  }

  private launchJob(job: EvalRunRecord): Promise<void> {
    const evalCase = this.dataset().cases.find((item) => item.caseId === job.caseId);
    if (!evalCase) throw new Error(`未找到评测 Case：${job.caseId}`);
    const fixture = this.fixture(job.caseId);
    const workspaceRoot = path.join(this.deps.repositoryRoot, ".eval-worktrees", `${job.evalRunId}-${safeSegment(job.caseId)}`);
    const sessionId = `eval_${safeSegment(job.caseId).replaceAll("-", "_")}_${Date.now()}`;
    return this.launch(job, evalCase, fixture, workspaceRoot, this.attemptDirectory(job), sessionId);
  }

  private async launch(
    job: EvalRunRecord,
    evalCase: DatasetCase,
    fixture: FixtureFile,
    workspaceRoot: string,
    attemptDirectory: string,
    sessionId: string
  ): Promise<void> {
    try {
      this.throwIfShuttingDown();
      await this.prepareWorkspace(job.caseId, workspaceRoot, fixture);
      this.throwIfShuttingDown();
      const started = await this.deps.startRun.execute({
        accessMode: "full_access",
        mode: evalCase.modeExpectation.initialMode,
        model: job.model,
        planEntry: "manual",
        projectRoot: workspaceRoot,
        prompt: evalCase.userRequest,
        sessionId,
        workspaceKind: "project"
      });
      job.runId = started.run.runId;
      job.sessionId = sessionId;
      job.stage = "running_agent";
      this.persistJob(job, attemptDirectory);
      this.watch(job, fixture, workspaceRoot, attemptDirectory);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      job.stage = "failed";
      this.persistJob(job, attemptDirectory);
      await this.removeWorkspace(workspaceRoot);
      this.onJobSettled(job);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownController.abort(new DOMException("Runtime 正在关闭。", "AbortError"));
      const finishedAt = new Date().toISOString();
      for (const job of this.jobs.values()) {
        if (job.stage !== "queued") continue;
        if (job.batchId && this.batchJobs.get(job.batchId)?.stage === "paused") continue;
        job.error = "Runtime 关闭前尚未开始。";
        job.finishedAt = finishedAt;
        job.stage = "cancelled";
        this.persistJob(job, this.attemptDirectory(job));
      }
      for (const batch of this.batchJobs.values()) this.updateBatch(batch);
    }
    await this.waitForBackgroundTasks();
  }

  async close(): Promise<void> {
    await this.shutdown();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    await this.waitForBackgroundTasks();
  }

  private dataset(): DatasetFile {
    return JSON.parse(readFileSync(path.join(this.deps.repositoryRoot, "evals/datasets/code-agent-v1.json"), "utf8")) as DatasetFile;
  }

  private fixture(caseId: string): FixtureFile {
    return JSON.parse(readFileSync(path.join(this.deps.repositoryRoot, "evals/fixtures", caseId, "fixture.json"), "utf8")) as FixtureFile;
  }

  private nextAttempt(experimentId: string, caseId: string): number {
    const directory = path.join(this.deps.repositoryRoot, "evals/runs", experimentId, caseId);
    if (!existsSync(directory)) return 1;
    return readdirSync(directory).reduce((maximum, name) => {
      const match = /^attempt-(\d+)$/.exec(name);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
  }

  private async prepareWorkspace(caseId: string, workspaceRoot: string, fixture: FixtureFile): Promise<void> {
    await this.withWorktreeMutation(async () => {
      this.throwIfShuttingDown();
      mkdirSync(path.dirname(workspaceRoot), { recursive: true });
      const add = await runShell(this.deps.repositoryRoot, `git worktree add --detach ${quoteRuntimeShellArgument(workspaceRoot)} ${quoteRuntimeShellArgument(fixture.base.revision)}`, this.shutdownController.signal);
      if (add.exitCode !== 0) throw new Error(`无法创建评测工作区：${add.output}`);
      if (!fixture.setupPatch) return;
      const patchPath = path.join(this.deps.repositoryRoot, "evals/fixtures", caseId, fixture.setupPatch);
      const patchResult = await runShell(workspaceRoot, `git apply --whitespace=nowarn -- ${quoteRuntimeShellArgument(patchPath)}`, this.shutdownController.signal);
      if (patchResult.exitCode !== 0) throw new Error(`无法应用 Fixture Patch：${patchResult.output}`);
      const commit = await runShell(workspaceRoot, "git add -A && git -c user.name='DeepCreator Eval' -c user.email='eval@deepcreator.local' commit -m 'eval: prepare fixture'", this.shutdownController.signal);
      if (commit.exitCode !== 0) throw new Error(`无法提交 Fixture 基线：${commit.output}`);
    });
  }

  private watch(job: EvalRunRecord, fixture: FixtureFile, workspaceRoot: string, attemptDirectory: string): void {
    if (!job.sessionId || !job.runId) return;
    const inspect = () => {
      const run = job.runId ? this.deps.store.getRun(job.runId) : undefined;
      if (!run) return;
      if (run.status === "waiting" && !this.interactionInFlight.has(job.evalRunId)) {
        this.interactionInFlight.add(job.evalRunId);
        const interaction = this.resolveFixtureInteraction(job, fixture.interactions ?? {}).catch(async (error) => {
          const unsubscribe = this.unsubscribers.get(job.evalRunId);
          unsubscribe?.();
          this.unsubscribers.delete(job.evalRunId);
          job.error = error instanceof Error ? error.message : String(error);
          job.finishedAt = new Date().toISOString();
          job.stage = "failed";
          this.persistJob(job, attemptDirectory);
          await this.removeWorkspace(workspaceRoot);
          this.onJobSettled(job);
        }).finally(() => this.interactionInFlight.delete(job.evalRunId));
        this.startBackground(interaction);
        return;
      }
      if (!isRunDone(run.status)) return;
      const unsubscribe = this.unsubscribers.get(job.evalRunId);
      unsubscribe?.();
      this.unsubscribers.delete(job.evalRunId);
      this.startBackground(this.finalize(job, workspaceRoot, attemptDirectory));
    };
    this.unsubscribers.set(job.evalRunId, this.deps.store.subscribe(job.sessionId, inspect));
    inspect();
  }

  private async resolveFixtureInteraction(job: EvalRunRecord, interactions: FixtureInteractions): Promise<void> {
    this.throwIfShuttingDown();
    if (!job.sessionId || !job.runId || !this.deps.launchRun || !this.deps.system) return;
    const session = this.deps.store.getSession(job.sessionId);
    const run = session?.runs.find((candidate) => candidate.runId === job.runId);
    if (!session || run?.status !== "waiting") return;
    const planResolution = resolveEvalPlanInteraction(session.plans, run.runId, interactions.continuePlanningOnce);
    if (planResolution) {
      const continuePlanning = planResolution.decision === "continue_planning";
      const result = resolvePlan({
        accessMode: continuePlanning ? undefined : "full_access",
        comments: planResolution.comments,
        decision: planResolution.decision,
        planId: planResolution.plan.planId,
        revision: planResolution.plan.revision,
        sessionId: session.sessionId,
        store: this.deps.store,
        system: this.deps.system
      });
      if (result.resume) this.resume(result.resume);
      return;
    }
    const question = [...session.questions].reverse().find((candidate) => candidate.runId === run.runId && candidate.status === "pending");
    if (!question || !interactions.answerQuestions) return;
    const answers = Object.fromEntries(question.prompts.map((prompt) => [
      prompt.questionId,
      this.answerFor(prompt, interactions.answerQuestions!)
    ]));
    const result = answerQuestion({
      answers,
      interactionId: question.interactionId,
      sessionId: session.sessionId,
      store: this.deps.store,
      system: this.deps.system
    });
    if (result.resume) this.resume(result.resume);
  }

  private answerFor(prompt: QuestionPrompt, strategy: NonNullable<FixtureInteractions["answerQuestions"]>): string {
    if (strategy === "diagnosis_only") {
      return prompt.options?.find((option) => /(?:暂不|不修改|仅.*诊断|只.*诊断)/.test(option))
        ?? "暂不修改，只保留诊断结论。";
    }
    return prompt.options?.[0] ?? "继续。";
  }

  private resume(resume: { model: string; protocol: "chat" | "responses"; projectRoot: string; prompt: string; runId: string; sessionId: string }): void {
    if (this.shuttingDown) return;
    this.deps.launchRun?.launch({ ...resume, continuation: true });
  }

  private async finalize(job: EvalRunRecord, workspaceRoot: string, attemptDirectory: string): Promise<void> {
    if (!job.sessionId || !job.runId) return;
    const run = this.deps.store.getRun(job.runId);
    if (!run) return;
    try {
      this.throwIfShuttingDown();
      job.stage = "verifying";
      this.persistJob(job, attemptDirectory);
      const finalizeInputPath = path.join(attemptDirectory, "finalize-input.json");
      writeFileSync(finalizeInputPath, JSON.stringify({
        attempt: job.attempt,
        attemptDirectory,
        caseId: job.caseId,
        events: this.deps.store.readEvents(job.sessionId, 0),
        experimentId: job.experimentId,
        judge: job.judge,
        judgeModel: job.judgeModel,
        model: job.model,
        promptVersion: job.promptVersion,
        repositoryRoot: this.deps.repositoryRoot,
        run,
        sessionId: job.sessionId,
        workspaceRoot
      }, null, 2), "utf8");
      job.stage = "judging";
      this.persistJob(job, attemptDirectory);
      const command = [
        "npx tsx --tsconfig tsconfig.evals.json evals/src/finalizeCli.ts --input",
        quoteRuntimeShellArgument(finalizeInputPath)
      ].join(" ");
      const finalized = await runShell(this.deps.repositoryRoot, command, this.shutdownController.signal);
      rmSync(finalizeInputPath, { force: true });
      if (finalized.exitCode !== 0) throw new Error(`评测评分失败：${finalized.output}`);
      job.result = JSON.parse(readFileSync(path.join(attemptDirectory, "result.json"), "utf8")) as EvalResultView;
      job.stage = run.status === "cancelled" ? "cancelled" : "completed";
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.stage = "failed";
    } finally {
      job.finishedAt = new Date().toISOString();
      this.persistJob(job, attemptDirectory);
      await this.removeWorkspace(workspaceRoot);
      this.onJobSettled(job);
    }
  }

  private attemptDirectory(job: EvalRunRecord): string {
    return path.join(
      this.deps.repositoryRoot,
      "evals/runs",
      safeSegment(job.experimentId),
      safeSegment(job.caseId),
      `attempt-${String(job.attempt).padStart(2, "0")}`
    );
  }

  private batchPath(batch: EvalBatchRunRecord): string {
    return path.join(
      this.deps.repositoryRoot,
      "evals/runs",
      safeSegment(batch.experimentId),
      "batches",
      `${safeSegment(batch.batchId)}.json`
    );
  }

  private persistBatch(batch: EvalBatchRunRecord): void {
    const filePath = this.batchPath(batch);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(batch, null, 2) + "\n", "utf8");
  }

  private updateBatch(batch: EvalBatchRunRecord): void {
    const runs = batch.cases.flatMap((item) => {
      const job = this.jobs.get(item.evalRunId);
      return job ? [job] : [];
    });
    const missingCases = batch.cases.filter((item) => !this.jobs.has(item.evalRunId));
    if (missingCases.length > 0) {
      batch.error = `缺少 ${missingCases.length} 个评测任务记录。`;
      batch.finishedAt ??= new Date().toISOString();
      batch.stage = "failed";
    } else {
      const summary = summarizeEvalBatch(batch.cases, runs);
      batch.completedCases = summary.completedCases;
      batch.failedCases = summary.failedCases;
      batch.passedCases = summary.passedCases;
      batch.weightedAverage = summary.weightedAverage;
      if (summary.completedCases === batch.cases.length) {
        batch.finishedAt ??= new Date().toISOString();
        batch.stage = "completed";
      }
    }
    this.persistBatch(batch);
  }

  private scheduleBatch(batch: EvalBatchRunRecord): void {
    if (this.shuttingDown || !evalBatchSchedulingEnabled(batch.stage)) return;
    const runs = batch.cases.flatMap((item) => {
      const job = this.jobs.get(item.evalRunId);
      return job ? [job] : [];
    });
    for (const job of selectQueuedEvalRuns(batch.cases, runs, batch.concurrency)) {
      job.stage = "preparing";
      this.persistJob(job, this.attemptDirectory(job));
      this.startBackground(this.launchJob(job));
    }
    this.updateBatch(batch);
  }

  private onJobSettled(job: EvalRunRecord): void {
    if (!job.batchId) return;
    const batch = this.batchJobs.get(job.batchId);
    if (!batch) return;
    this.updateBatch(batch);
    this.scheduleBatch(batch);
  }

  private persistJob(job: EvalRunRecord, attemptDirectory: string): void {
    mkdirSync(attemptDirectory, { recursive: true });
    writeFileSync(path.join(attemptDirectory, "eval-run.json"), JSON.stringify(job, null, 2) + "\n", "utf8");
  }

  private async removeWorkspace(workspaceRoot: string): Promise<void> {
    await this.withWorktreeMutation(async () => {
      if (!existsSync(workspaceRoot)) return;
      const result = await runShell(this.deps.repositoryRoot, `git worktree remove --force ${quoteRuntimeShellArgument(workspaceRoot)}`);
      if (result.exitCode !== 0) rmSync(workspaceRoot, { force: true, recursive: true });
      await runShell(this.deps.repositoryRoot, "git worktree prune");
    });
  }

  private withWorktreeMutation(task: () => Promise<void>): Promise<void> {
    const next = this.worktreeMutation.then(task, task);
    this.worktreeMutation = next.catch(() => undefined);
    return next;
  }

  private startBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task)
    );
  }

  private async waitForBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  private throwIfShuttingDown(): void {
    if (this.shuttingDown) throw this.shutdownController.signal.reason ?? new DOMException("Runtime 正在关闭。", "AbortError");
  }
}
