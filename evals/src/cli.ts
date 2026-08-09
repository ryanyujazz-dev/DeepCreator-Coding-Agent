import path from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_EVAL_JUDGE, DEFAULT_EVAL_JUDGE_MODEL } from "../../shared/contracts/evals";
import { fixtureManifestPath, loadDataset } from "./dataset";
import { runEvalCase } from "./runner";

function argumentsMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) values.set(current.slice(2), "true");
    else {
      values.set(current.slice(2), next);
      index += 1;
    }
  }
  return values;
}

function usage(): string {
  return [
    "用法：",
    "  npm run eval:list",
    "  npm run eval:run -- --case CAE-003 --model deepseek-v4-flash --prompt-version prompt-v1",
    "",
    "可选参数：",
    "  --experiment <id>       实验标识，默认 eval-YYYY-MM-DD",
    "  --attempt <n>           重复运行编号，默认 1",
    "  --judge heuristic|provider  默认 provider",
    "  --judge-model <model>    Provider Judge 模型，默认 deepseek-v4-flash",
    "  --keep-workspace         保留临时 Worktree"
  ].join("\n");
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const repositoryRoot = path.resolve(process.cwd());
  const dataset = loadDataset(path.join(repositoryRoot, "evals/datasets/code-agent-v1.json"));
  if (command === "list") {
    for (const item of dataset.cases) {
      const runnable = existsSync(fixtureManifestPath(item.caseId));
      console.log(`${item.caseId}\t${runnable ? "ready" : "planned"}\t${item.scenario}\t${item.title}`);
    }
    return;
  }
  if (command !== "run") {
    console.log(usage());
    return;
  }
  const args = argumentsMap(rest);
  const caseId = args.get("case");
  if (!caseId) throw new Error("缺少 --case。");
  const model = args.get("model") ?? "mock-agent";
  const promptVersion = args.get("prompt-version") ?? "current";
  const experimentId = args.get("experiment") ?? `eval-${new Date().toISOString().slice(0, 10)}`;
  const attempt = Number(args.get("attempt") ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new Error("--attempt 必须是正整数。");
  const judge = args.get("judge") ?? DEFAULT_EVAL_JUDGE;
  if (judge !== "heuristic" && judge !== "provider") throw new Error("--judge 必须是 heuristic 或 provider。");
  const completed = await runEvalCase({
    attempt,
    caseId,
    experimentId,
    judge,
    judgeModel: judge === "provider" ? args.get("judge-model") ?? DEFAULT_EVAL_JUDGE_MODEL : undefined,
    keepWorkspace: args.get("keep-workspace") === "true",
    model,
    promptVersion,
    repositoryRoot
  });
  console.log(`Eval 完成：${completed.result.caseId} ${completed.result.scores.total}/100 ${completed.result.passed ? "PASS" : "FAIL"}`);
  console.log(`结果目录：${completed.attemptDirectory}`);
  console.log(`报告目录：${path.join(repositoryRoot, "evals/runs/reports", experimentId)}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
