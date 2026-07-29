import { readFileSync } from "node:fs";
import path from "node:path";
import { Run } from "../../shared/contracts/runtime";
import { runShell } from "../../server/infra/tools/shellExecution";
import { AssertionResult, EvalFixtureManifest, FixtureAssertion } from "./types";

const EMPTY_COMMAND_OUTPUT = "命令执行完成，无输出。";

function outputText(output: string): string {
  return output.trim() === EMPTY_COMMAND_OUTPUT ? "" : output.trim();
}

function workspacePath(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`断言路径越界：${relativePath}`);
  return target;
}

async function evaluateAssertion(
  assertion: FixtureAssertion,
  workspaceRoot: string,
  run: Run
): Promise<AssertionResult> {
  let passed: boolean;
  let detail: string;
  if (assertion.kind === "run_completed") {
    passed = run.status === "completed";
    detail = `Run 状态为 ${run.status}。`;
  } else if (assertion.kind === "run_answer_contains") {
    passed = run.answer.includes(assertion.text);
    detail = passed
      ? `最终回答包含 ${JSON.stringify(assertion.text)}。`
      : `最终回答不包含 ${JSON.stringify(assertion.text)}。`;
  } else if (assertion.kind === "command") {
    const result = await runShell(workspaceRoot, assertion.command);
    passed = result.exitCode === assertion.expectedExitCode;
    detail = `命令退出码 ${result.exitCode}，期望 ${assertion.expectedExitCode}。${result.output ? `\n${result.output.slice(0, 1_500)}` : ""}`;
  } else if (assertion.kind === "git_diff_empty") {
    const result = await runShell(workspaceRoot, "git status --short");
    const output = outputText(result.output);
    passed = result.exitCode === 0 && !output;
    detail = passed ? "工作区没有变更。" : `检测到工作区变更：\n${output}`;
  } else if (assertion.kind === "git_diff_excludes") {
    const result = await runShell(workspaceRoot, "git diff --name-only && git ls-files --others --exclude-standard");
    const changed = outputText(result.output).split("\n").map((item) => item.trim()).filter(Boolean);
    const forbidden = changed.filter((file) => assertion.paths.some((candidate) => file === candidate || file.startsWith(`${candidate}/`)));
    passed = result.exitCode === 0 && forbidden.length === 0;
    detail = passed ? "禁止范围内没有文件变更。" : `禁止范围发生变更：${forbidden.join(", ")}`;
  } else {
    const content = readFileSync(workspacePath(workspaceRoot, assertion.path), "utf8");
    passed = assertion.kind === "file_contains" ? content.includes(assertion.text) : !content.includes(assertion.text);
    detail = `${assertion.path} ${passed ? "满足" : "不满足"} ${assertion.kind} 断言。`;
  }
  return {
    assertionId: assertion.id,
    detail,
    kind: assertion.kind,
    passed,
    pointsAwarded: passed ? assertion.points : 0,
    pointsAvailable: assertion.points
  };
}

export async function runFixtureAssertions(
  fixture: EvalFixtureManifest,
  workspaceRoot: string,
  run: Run
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of fixture.assertions) {
    try {
      results.push(await evaluateAssertion(assertion, workspaceRoot, run));
    } catch (error) {
      results.push({
        assertionId: assertion.id,
        detail: error instanceof Error ? error.message : String(error),
        kind: assertion.kind,
        passed: false,
        pointsAwarded: 0,
        pointsAvailable: assertion.points
      });
    }
  }
  return results;
}
