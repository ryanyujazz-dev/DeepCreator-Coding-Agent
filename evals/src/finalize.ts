import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Event, Run } from "../../shared/contracts/runtime";
import { DeepSeekProvider } from "../../server/infra/deepseek";
import { loadUserConfig } from "../../server/infra/userConfig";
import { ZhipuProvider } from "../../server/infra/zhipu";
import { runShell } from "../../server/infra/tools/shellExecution";
import { runFixtureAssertions } from "./assertions";
import { ContentJudge, HeuristicContentJudge, ProviderContentJudge } from "./contentJudge";
import { findCase, loadDataset, loadFixture } from "./dataset";
import { evaluateRun } from "./evaluator";
import { writeReports } from "./report";
import { EvalExperimentSummary, EvalResult } from "./types";

function contentJudgeFor(kind: "heuristic" | "provider", model?: string): ContentJudge {
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

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`路径标识包含非法字符：${value}`);
  return value;
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

export async function finalizeExistingEvalRun(options: {
  attempt: number;
  attemptDirectory: string;
  caseId: string;
  events: Event[];
  experimentId: string;
  judge: "heuristic" | "provider";
  judgeModel?: string;
  model: string;
  onStage?: (stage: "verifying" | "judging") => void;
  promptVersion: string;
  repositoryRoot: string;
  run: Run;
  sessionId: string;
  workspaceRoot: string;
}): Promise<{ result: EvalResult; summary: EvalExperimentSummary }> {
  const dataset = loadDataset(path.join(options.repositoryRoot, "evals/datasets/code-agent-v1.json"));
  const evalCase = findCase(dataset, options.caseId);
  const fixture = loadFixture(options.caseId);
  const outputRoot = path.join(options.repositoryRoot, "evals/runs");
  mkdirSync(options.attemptDirectory, { recursive: true });
  options.onStage?.("verifying");
  const assertions = await runFixtureAssertions(fixture, options.workspaceRoot, options.run);
  const diff = await runShell(options.workspaceRoot, "git diff --binary --no-ext-diff");
  const diffOutput = diff.output.trim() === "命令执行完成，无输出。" ? "" : diff.output;
  writeFileSync(path.join(options.attemptDirectory, "trace.jsonl"), options.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  writeFileSync(path.join(options.attemptDirectory, "run.json"), JSON.stringify(options.run, null, 2) + "\n", "utf8");
  writeFileSync(path.join(options.attemptDirectory, "diff.patch"), diffOutput + (diffOutput ? "\n" : ""), "utf8");
  writeFileSync(path.join(options.attemptDirectory, "verification.json"), JSON.stringify(assertions, null, 2) + "\n", "utf8");
  options.onStage?.("judging");
  const result = await evaluateRun({
    assertions,
    attempt: options.attempt,
    contentJudge: contentJudgeFor(options.judge, options.judgeModel),
    dataset,
    evalCase,
    events: options.events,
    model: options.model,
    promptVersion: options.promptVersion,
    run: options.run,
    sessionId: options.sessionId
  });
  writeFileSync(path.join(options.attemptDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  return { result, summary: mergeExperimentResult(outputRoot, options.experimentId, result) };
}
