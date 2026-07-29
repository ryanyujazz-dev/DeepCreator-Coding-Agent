import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EvalCaseSummary,
  EvalResultView,
  EvalRunRecord,
  StartEvalRunInput
} from "../../shared/contracts/evals";
import { Event, isRunDone, Session } from "../../shared/contracts/runtime";
import { rebuildSession } from "../../shared/domain/reducer";
import { StartRun } from "../app/startRun";
import { EventPort, SessionPort } from "../app/runtimeRepo";
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
type FixtureFile = { base: { revision: string }; setupPatch?: string; status: "planned" | "ready" };
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

const ACTIVE_STAGES = new Set<EvalRunRecord["stage"]>(["preparing", "running_agent", "verifying", "judging"]);

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

export function loadPersistedEvalRuns(repositoryRoot: string): EvalRunRecord[] {
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
          const activeInterrupted = ACTIVE_STAGES.has(savedJob.stage) && !result;
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
  private readonly jobs = new Map<string, EvalRunRecord>();
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(private readonly deps: {
    repositoryRoot: string;
    startRun: StartRun;
    store: EventPort & SessionPort;
  }) {
    for (const run of loadPersistedEvalRuns(deps.repositoryRoot)) this.jobs.set(run.evalRunId, run);
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
    if (this.runs().some((job) => ACTIVE_STAGES.has(job.stage))) {
      throw new Error("当前已有评测正在运行，请等待完成或先停止当前任务。");
    }
    const evalCase = this.dataset().cases.find((item) => item.caseId === input.caseId);
    if (!evalCase) throw new Error(`未找到评测 Case：${input.caseId}`);
    if (evalCase.fixture.status !== "ready") throw new Error(`${input.caseId} 尚未配置可运行 Fixture。`);
    const fixture = this.fixture(input.caseId);
    if (fixture.status !== "ready") throw new Error(`${input.caseId} Fixture 尚未就绪。`);

    const evalRunId = `evalrun_${randomUUID().replaceAll("-", "")}`;
    const experimentId = `developer-ui-${new Date().toISOString().slice(0, 10)}`;
    const attempt = this.nextAttempt(experimentId, input.caseId);
    const attemptName = `attempt-${String(attempt).padStart(2, "0")}`;
    const workspaceRoot = path.join(this.deps.repositoryRoot, ".eval-worktrees", `${evalRunId}-${safeSegment(input.caseId)}`);
    const attemptDirectory = path.join(this.deps.repositoryRoot, "evals/runs", experimentId, safeSegment(input.caseId), attemptName);
    const sessionId = `eval_${safeSegment(input.caseId).replaceAll("-", "_")}_${Date.now()}`;
    const job: EvalRunRecord = {
      attempt,
      caseId: input.caseId,
      createdAt: new Date().toISOString(),
      evalRunId,
      experimentId,
      judge: input.judge ?? "heuristic",
      judgeModel: input.judgeModel,
      model: input.model,
      promptVersion: input.promptVersion ?? "current",
      stage: "preparing"
    };
    this.jobs.set(evalRunId, job);
    mkdirSync(attemptDirectory, { recursive: true });
    this.persistJob(job, attemptDirectory);

    void this.launch(job, evalCase, fixture, workspaceRoot, attemptDirectory, sessionId);
    return job;
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
      await this.prepareWorkspace(job.caseId, workspaceRoot, fixture);
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
      this.watch(job, workspaceRoot, attemptDirectory);
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      job.stage = "failed";
      this.persistJob(job, attemptDirectory);
      await this.removeWorkspace(workspaceRoot);
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
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
    mkdirSync(path.dirname(workspaceRoot), { recursive: true });
    const add = await runShell(this.deps.repositoryRoot, `git worktree add --detach ${quoteRuntimeShellArgument(workspaceRoot)} ${quoteRuntimeShellArgument(fixture.base.revision)}`);
    if (add.exitCode !== 0) throw new Error(`无法创建评测工作区：${add.output}`);
    if (!fixture.setupPatch) return;
    const patchPath = path.join(this.deps.repositoryRoot, "evals/fixtures", caseId, fixture.setupPatch);
    const patchResult = await runShell(workspaceRoot, `git apply --whitespace=nowarn -- ${quoteRuntimeShellArgument(patchPath)}`);
    if (patchResult.exitCode !== 0) throw new Error(`无法应用 Fixture Patch：${patchResult.output}`);
    const commit = await runShell(workspaceRoot, "git add -A && git -c user.name='DeepCreator Eval' -c user.email='eval@deepcreator.local' commit -m 'eval: prepare fixture'");
    if (commit.exitCode !== 0) throw new Error(`无法提交 Fixture 基线：${commit.output}`);
  }

  private watch(job: EvalRunRecord, workspaceRoot: string, attemptDirectory: string): void {
    if (!job.sessionId || !job.runId) return;
    const inspect = () => {
      const run = job.runId ? this.deps.store.getRun(job.runId) : undefined;
      if (!run || !isRunDone(run.status)) return;
      const unsubscribe = this.unsubscribers.get(job.evalRunId);
      unsubscribe?.();
      this.unsubscribers.delete(job.evalRunId);
      void this.finalize(job, workspaceRoot, attemptDirectory);
    };
    this.unsubscribers.set(job.evalRunId, this.deps.store.subscribe(job.sessionId, inspect));
    inspect();
  }

  private async finalize(job: EvalRunRecord, workspaceRoot: string, attemptDirectory: string): Promise<void> {
    if (!job.sessionId || !job.runId) return;
    const run = this.deps.store.getRun(job.runId);
    if (!run) return;
    try {
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
      const finalized = await runShell(this.deps.repositoryRoot, command);
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
    }
  }

  private persistJob(job: EvalRunRecord, attemptDirectory: string): void {
    mkdirSync(attemptDirectory, { recursive: true });
    writeFileSync(path.join(attemptDirectory, "eval-run.json"), JSON.stringify(job, null, 2) + "\n", "utf8");
  }

  private async removeWorkspace(workspaceRoot: string): Promise<void> {
    if (!existsSync(workspaceRoot)) return;
    const result = await runShell(this.deps.repositoryRoot, `git worktree remove --force ${quoteRuntimeShellArgument(workspaceRoot)}`);
    if (result.exitCode !== 0) rmSync(workspaceRoot, { force: true, recursive: true });
    await runShell(this.deps.repositoryRoot, "git worktree prune");
  }
}
