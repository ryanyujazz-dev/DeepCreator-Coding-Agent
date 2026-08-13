import { runShell } from "./shellExecution";
import { quoteRuntimeShellArgument } from "../shell";

/** git_diff:只读查看工作区/暂存区真实改动(unified diff)。
 *  复用 runShell(git_status 同款):自带 signal abort + 120s 硬超时,无托管命令生命周期。 */
export async function gitDiff(
  projectRoot: string,
  input: { path?: string; staged?: boolean },
  signal?: AbortSignal
): Promise<{ exitCode: number; output: string }> {
  const path = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
  // 无参 git diff 只显示工作区 vs 暂存区(已 add 的新文件会消失);
  // git diff HEAD 显示"工作区+暂存区"相对上次提交的全部改动,符合设计稿语义。
  const command = [
    input.staged === true ? "git diff --cached" : "git diff HEAD",
    path ? `-- ${quoteRuntimeShellArgument(path)}` : undefined
  ].filter(Boolean).join(" ");
  const result = await runShell(projectRoot, command, signal);
  if (result.exitCode !== 0) return result;
  return { exitCode: 0, output: result.output.trim() === "" || result.output === "命令执行完成，无输出。" ? "没有改动。" : result.output };
}

/** git_commit:把暂存区改动提交为一个 commit(受审批的写操作)。
 *  不自动 git add——只提交暂存区;message 经 shell 引号包裹防注入;
 *  amend 用 --amend -m(覆盖原 message,描述已声明)。 */
export async function gitCommit(
  projectRoot: string,
  input: { message: string; amend?: boolean },
  signal?: AbortSignal
): Promise<{ exitCode: number; output: string }> {
  const message = input.message.trim();
  if (!message) throw new Error("message 不能为空。");
  const commitCommand = [
    "git commit",
    input.amend === true ? "--amend" : undefined,
    `-m ${quoteRuntimeShellArgument(message)}`
  ].filter(Boolean).join(" ");
  const commit = await runShell(projectRoot, commitCommand, signal);
  if (commit.exitCode !== 0) return commit; // git stderr 原样返回(含 nothing to commit 等)
  // 成功后取 branch + sha 组装摘要(target doc 格式:[{branch} {sha7}] {message 首行})
  const summary = await runShell(
    projectRoot,
    "git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD",
    signal
  );
  if (summary.exitCode !== 0) return { exitCode: 0, output: commit.output };
  const [branch, sha] = summary.output.split("\n").map((line) => line.trim()).filter(Boolean);
  return { exitCode: 0, output: `[${branch ?? "?"} ${sha ?? "?"}] ${message.split("\n")[0]}` };
}
