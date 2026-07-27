import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "../../shared/contracts/runtime";
import { startRuntime } from "../../server/bootstrap/runtime";
import { DeepSeekProvider } from "../../server/infra/deepseek";
import { loadUserConfig } from "../../server/infra/userConfig";
import { ZhipuProvider } from "../../server/infra/zhipu";
import { quoteRuntimeShellArgument } from "../../server/infra/shell";
import { runShell } from "../../server/infra/tools/shellExecution";
import { runFixtureAssertions } from "./assertions";
import { ContentJudge, HeuristicContentJudge, ProviderContentJudge } from "./contentJudge";
import { findCase, loadDataset, loadFixture } from "./dataset";
import { evaluateRun } from "./evaluator";
import { writeReports } from "./report";
import { EvalExperimentSummary, EvalResult } from "./types";

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
  const commit = await runShell(workspaceRoot, "git add -A && git -c user.name='DeepSeeker Eval' -c user.email='eval@deepseeker.local' commit -m 'eval: prepare fixture'");
  if (commit.exitCode !== 0) throw new Error(`无法提交 Fixture 基线：${commit.output}`);
}

async function removeWorktree(repositoryRoot: string, workspaceRoot: string): Promise<void> {
  const result = await runShell(repositoryRoot, `git worktree remove --force ${quoteRuntimeShellArgument(workspaceRoot)}`);
  if (result.exitCode !== 0) rmSync(workspaceRoot, { force: true, recursive: true });
  await runShell(repositoryRoot, "git worktree prune");
}

function contentJudgeFor(kind: EvalRunOptions["judge"], model?: string): ContentJudge {
  if (kind === "heuristic") return new HeuristicContentJudge();
  const config = loadUserConfig();
  const selected = model ?? (/^glm[-.]/i.test(config.model) ? "glm-5-turbo" : "deepseek-v4-flash");
  if (/^glm[-.]/i.test(selected)) {
    if (!config.zhipuApiKey) throw new Error("Provider Judge 需要智谱 API Key。");
    return new ProviderContentJudge(new ZhipuProvider(config.zhipuApiKey), selected);
  }
  if (!config.apiKey) throw new Error("Provider Judge 需要 DeepSeek API Key。");
  return new ProviderContentJudge(new DeepSeekProvider(config.apiKey), selected);
}

async function waitForTerminal(baseUrl: string, sessionId: string, timeoutMs: number): Promise<Session> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await requestJson<{ session: Session }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
    const run = response.session.runs.at(-1);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return response.session;
    if (run?.status === "waiting") {
      throw new Error("Eval Run 正在等待用户审批或回答。当前 MVP 不自动替用户作出产品决策，请使用 Work 模式 Case 或手动导入 Trace 评分。");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Eval Run 超过 ${Math.ceil(timeoutMs / 1_000)} 秒仍未结束。`);
}

function mergeExperimentResult(outputRoot: string, experimentId: string, result: EvalResult): EvalExperimentSummary {
  const reportDirectory = path.join(outputRoot, "reports", safeSegment(experimentId));
  const summaryPath = path.join(reportDirectory, "summary.json");
  const previous = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, "utf8")) as EvalExperimentSummary
    : { experimentId, generatedAt: new Date().toISOString(), results: [] };
  const identity = `${result.caseId}:${result.model}:${result.promptVersion}:${result.attempt}`;
  const results = previous.results.filter((item) => `${item.caseId}:${item.model}:${item.promptVersion}:${item.attempt}` !== identity);
  results.push(result);
  const summary = { experimentId, generatedAt: new Date().toISOString(), results };
  writeReports(summary, reportDirectory);
  return summary;
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
    const session = await waitForTerminal(baseUrl, sessionId, fixture.timeoutMs ?? 10 * 60_000);
    const run = session.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error(`无法读取 Eval Run：${runId}`);
    const eventResponse = await requestJson<{ events: import("../../shared/contracts/runtime").Event[] }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events?afterOffset=0`);
    await runtime.close();
    runtime = undefined;
    const assertions = await runFixtureAssertions(fixture, workspaceRoot, run);
    const diff = await runShell(workspaceRoot, "git diff --binary --no-ext-diff");
    const diffOutput = diff.output.trim() === "命令执行完成，无输出。" ? "" : diff.output;
    writeFileSync(path.join(attemptDirectory, "trace.jsonl"), eventResponse.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    writeFileSync(path.join(attemptDirectory, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
    writeFileSync(path.join(attemptDirectory, "diff.patch"), diffOutput + (diffOutput ? "\n" : ""), "utf8");
    writeFileSync(path.join(attemptDirectory, "verification.json"), JSON.stringify(assertions, null, 2) + "\n", "utf8");
    const result = await evaluateRun({
      assertions,
      attempt: options.attempt,
      contentJudge: contentJudgeFor(options.judge, options.judgeModel),
      dataset,
      evalCase,
      events: eventResponse.events,
      model: options.model,
      promptVersion: options.promptVersion,
      run,
      sessionId
    });
    writeFileSync(path.join(attemptDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    const summary = mergeExperimentResult(outputRoot, options.experimentId, result);
    return { attemptDirectory, result, summary };
  } finally {
    await runtime?.close().catch(() => undefined);
    if (prepared && !options.keepWorkspace) await removeWorktree(options.repositoryRoot, workspaceRoot);
  }
}
