import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { QuestionPrompt, Session } from "../../shared/contracts/runtime";
import { startRuntime } from "../../server/bootstrap/runtime";
import { loadUserConfig } from "../../server/infra/userConfig";
import { quoteRuntimeShellArgument } from "../../server/infra/shell";
import { runShell } from "../../server/infra/tools/shellExecution";
import { findCase, loadDataset, loadFixture } from "./dataset";
import { finalizeExistingEvalRun } from "./finalize";
import { EvalExperimentSummary, EvalFixtureManifest, EvalResult } from "./types";

export type EvalRunOptions = {
  attempt: number;
  caseId: string;
  experimentId: string;
  judge: "heuristic" | "provider";
  judgeModel?: string;
  keepWorkspace?: boolean;
  model: string;
  promptVersion: string;
  repositoryRoot: string;
};

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`路径标识包含非法字符：${value}`);
  return value;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers
  });
  if (!response.ok) throw new Error(`Runtime 请求失败 ${response.status}：${await response.text()}`);
  return await response.json() as T;
}

async function prepareWorktree(repositoryRoot: string, workspaceRoot: string, revision: string, setupPatch?: string): Promise<void> {
  mkdirSync(path.dirname(workspaceRoot), { recursive: true });
  const add = await runShell(repositoryRoot, `git worktree add --detach ${quoteRuntimeShellArgument(workspaceRoot)} ${quoteRuntimeShellArgument(revision)}`);
  if (add.exitCode !== 0) throw new Error(`无法创建 Eval Worktree：${add.output}`);
  if (!setupPatch) return;
  const patchResult = await runShell(workspaceRoot, `git apply --whitespace=nowarn -- ${quoteRuntimeShellArgument(setupPatch)}`);
  if (patchResult.exitCode !== 0) throw new Error(`无法应用 Fixture Patch：${patchResult.output}`);
  const commit = await runShell(workspaceRoot, "git add -A && git -c user.name='DeepCreator Eval' -c user.email='eval@deepcreator.local' commit -m 'eval: prepare fixture'");
  if (commit.exitCode !== 0) throw new Error(`无法提交 Fixture 基线：${commit.output}`);
}

async function removeWorktree(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  const result = await runShell(repositoryRoot, `git worktree remove --force ${quoteRuntimeShellArgument(workspaceRoot)}`);
  if (result.exitCode !== 0) rmSync(workspaceRoot, { force: true, recursive: true });
  await runShell(repositoryRoot, "git worktree prune");
}

function answerFor(prompt: QuestionPrompt, strategy: NonNullable<EvalFixtureManifest["interactions"]>["answerQuestions"]): string {
  if (strategy === "diagnosis_only") {
    const diagnosis = prompt.options?.find((option) => /(?:暂不|不修改|仅.*诊断|只.*诊断)/.test(option));
    return diagnosis ?? "暂不修改，只保留诊断结论。";
  }
  return prompt.options?.[0] ?? "继续。";
}

export async function resolveWaitingInteraction(
  baseUrl: string,
  session: Session,
  interactions: EvalFixtureManifest["interactions"]
): Promise<boolean> {
  const run = session.runs.at(-1);
  if (!run || run.status !== "waiting") return false;
  const plan = [...session.plans].reverse().find((candidate) => candidate.runId === run.runId && candidate.status === "proposed");
  if (plan && interactions?.autoApprovePlan) {
    await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(session.sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}/resolve`, {
      body: JSON.stringify({ accessMode: "full_access", decision: "start_work" }),
      method: "POST"
    });
    return true;
  }
  const question = [...session.questions].reverse().find((candidate) => candidate.runId === run.runId && candidate.status === "pending");
  if (question && interactions?.answerQuestions) {
    const answers = Object.fromEntries(question.prompts.map((prompt) => [
      prompt.questionId,
      answerFor(prompt, interactions.answerQuestions)
    ]));
    await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(session.sessionId)}/questions/${encodeURIComponent(question.interactionId)}/answer`, {
      body: JSON.stringify({ answers }),
      method: "POST"
    });
    return true;
  }
  return false;
}

async function waitForTerminal(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
  interactions?: EvalFixtureManifest["interactions"]
): Promise<Session> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await requestJson<{ session: Session }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
    const run = response.session.runs.at(-1);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return response.session;
    if (run?.status === "waiting") {
      if (await resolveWaitingInteraction(baseUrl, response.session, interactions)) continue;
      throw new Error("Eval Run 正在等待用户审批或回答，但 Fixture 没有配置对应的交互策略。");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Eval Run 超过 ${Math.ceil(timeoutMs / 1_000)} 秒仍未结束。`);
}

export async function runEvalCase(options: EvalRunOptions): Promise<{ attemptDirectory: string; result: EvalResult; summary: EvalExperimentSummary }> {
  const dataset = loadDataset(path.join(options.repositoryRoot, "evals/datasets/code-agent-v1.json"));
  const evalCase = findCase(dataset, options.caseId);
  const fixture = loadFixture(options.caseId);
  const attemptName = `attempt-${String(options.attempt).padStart(2, "0")}`;
  const outputRoot = path.join(options.repositoryRoot, "evals/runs");
  const attemptDirectory = path.join(outputRoot, safeSegment(options.experimentId), safeSegment(options.caseId), attemptName);
  const workspaceRoot = path.join(options.repositoryRoot, ".eval-worktrees", `${safeSegment(options.experimentId)}-${safeSegment(options.caseId)}-${attemptName}`);
  const fixtureDirectory = path.join(options.repositoryRoot, "evals/fixtures", options.caseId);
  const setupPatch = fixture.setupPatch ? path.join(fixtureDirectory, fixture.setupPatch) : undefined;
  mkdirSync(attemptDirectory, { recursive: true });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let prepared = false;
  try {
    await prepareWorktree(options.repositoryRoot, workspaceRoot, fixture.base.revision, setupPatch);
    prepared = true;
    const config = loadUserConfig();
    runtime = await startRuntime({
      apiKey: config.apiKey,
      dataDirectory: path.join(attemptDirectory, "runtime"),
      defaultModel: options.model,
      host: "127.0.0.1",
      migrationDirectory: path.join(options.repositoryRoot, "server/infra/migrations"),
      port: 0,
      runtimeMode: options.model === "mock-agent" ? "mock" : undefined,
      workspaceRoot,
      zhipuApiKey: config.zhipuApiKey
    });
    const baseUrl = `http://${runtime.host}:${runtime.port}`;
    const sessionId = `eval_${safeSegment(options.caseId).replaceAll("-", "_")}_${Date.now()}`;
    const started = await requestJson<{ session: Session }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      body: JSON.stringify({
        accessMode: "full_access",
        mode: evalCase.modeExpectation.initialMode,
        model: options.model,
        planEntry: "manual",
        projectRoot: workspaceRoot,
        prompt: evalCase.userRequest
      }),
      method: "POST"
    });
    const runId = started.session.runs.at(-1)?.runId;
    if (!runId) throw new Error("Runtime 没有返回 runId。");
    const session = await waitForTerminal(baseUrl, sessionId, fixture.timeoutMs ?? 10 * 60_000, fixture.interactions);
    const run = session.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error(`无法读取 Eval Run：${runId}`);
    const eventResponse = await requestJson<{ events: import("../../shared/contracts/runtime").Event[] }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events?afterOffset=0`);
    await runtime.close();
    runtime = undefined;
    const completed = await finalizeExistingEvalRun({
      attempt: options.attempt,
      attemptDirectory,
      caseId: options.caseId,
      events: eventResponse.events,
      experimentId: options.experimentId,
      judge: options.judge,
      judgeModel: options.judgeModel,
      model: options.model,
      promptVersion: options.promptVersion,
      repositoryRoot: options.repositoryRoot,
      run,
      sessionId,
      workspaceRoot
    });
    return { attemptDirectory, ...completed };
  } finally {
    await runtime?.close().catch(() => undefined);
    if (prepared && !options.keepWorkspace) await removeWorktree(options.repositoryRoot, workspaceRoot);
  }
}
