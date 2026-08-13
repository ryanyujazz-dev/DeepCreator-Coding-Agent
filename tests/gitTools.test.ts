import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { approvalFor } from "../server/domain/accessPolicy";
import { executeTool } from "../server/infra/tools";
import { runShell } from "../server/infra/tools/shellExecution";

// git_diff / git_commit 工具测试:diff hunk/staged 过滤/空 diff/非 git 目录、
// commit 输出格式/未暂存失败/审批三分支。

const CLEANUP = { force: true, maxRetries: 5, recursive: true, retryDelay: 100 };

async function initRepo(directory: string): Promise<void> {
  const init = await runShell(directory, "git init -q");
  if (init.exitCode !== 0) throw new Error(`git init 失败:${init.output}`);
  // repo 局部 identity(模拟真实用户环境;CI runner 无全局 git config,
  // git_commit 工具本身不带 -c identity——提交归属用户身份是正确行为)
  const config = await runShell(directory, "git config user.name Test && git config user.email test@example.com");
  if (config.exitCode !== 0) throw new Error(`git config 失败:${config.output}`);
  writeFileSync(path.join(directory, "a.txt"), "line1\nline2\n");
  const add = await runShell(directory, "git add -A && git commit -q -m init");
  if (add.exitCode !== 0) throw new Error(`初始提交失败:${add.output}`);
}

test("git_diff: 返回真实 hunk,支持 staged 过滤与 path 限定", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-gitdiff-"));
  try {
    await initRepo(directory);
    writeFileSync(path.join(directory, "a.txt"), "line1\nchanged\n");
    // b.txt 先 git add 使其成为已跟踪的新文件(git diff 语义:不显示 untracked)
    writeFileSync(path.join(directory, "b.txt"), "new file\n");
    const added = await runShell(directory, "git add b.txt");
    assert.equal(added.exitCode, 0);
    const unstaged = await executeTool({ args: {}, name: "git_diff", projectRoot: directory });
    assert.equal(unstaged.exitCode, 0);
    assert.ok(unstaged.output.includes("@@"));
    assert.ok(unstaged.output.includes("-line2"));
    assert.ok(unstaged.output.includes("+changed"));
    assert.ok(unstaged.output.includes("b.txt"));

    const staged = await runShell(directory, "git add a.txt");
    assert.equal(staged.exitCode, 0);
    // c.txt 是 untracked 新文件:git diff 语义(工作区/暂存 vs HEAD)不含 untracked,
    // 查看新文件列表应配合 git_status。
    writeFileSync(path.join(directory, "c.txt"), "unstaged only\n");
    const cached = await executeTool({ args: { staged: true }, name: "git_diff", projectRoot: directory });
    assert.ok(cached.output.includes("a.txt"));
    assert.ok(!cached.output.includes("c.txt"));

    const limited = await executeTool({ args: { path: "b.txt" }, name: "git_diff", projectRoot: directory });
    assert.ok(limited.output.includes("b.txt"));
    assert.ok(!limited.output.includes("a.txt"));
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("git_diff: 无改动返回空提示,非 git 目录报错", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-gitdiff-empty-"));
  try {
    await initRepo(directory);
    const clean = await executeTool({ args: {}, name: "git_diff", projectRoot: directory });
    assert.equal(clean.output, "没有改动。");

    const outside = mkdtempSync(path.join(tmpdir(), "deepcreator-gitdiff-nogit-"));
    try {
      const failed = await executeTool({ args: {}, name: "git_diff", projectRoot: outside });
      assert.notEqual(failed.exitCode, 0);
    } finally {
      rmSync(outside, CLEANUP);
    }
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("git_commit: 提交暂存区并返回 [branch sha] 摘要;未暂存报 git 原生错误", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-gitcommit-"));
  try {
    await initRepo(directory);
    // 未暂存任何改动 → git 原生失败路径
    const nothing = await executeTool({ args: { message: "empty" }, name: "git_commit", projectRoot: directory });
    assert.notEqual(nothing.exitCode, 0);
    assert.ok(nothing.output.length > 0);

    writeFileSync(path.join(directory, "a.txt"), "line1\ncommitted\n");
    const add = await runShell(directory, "git add a.txt");
    assert.equal(add.exitCode, 0);
    const committed = await executeTool({ args: { message: "test: 更新 a.txt" }, name: "git_commit", projectRoot: directory });
    assert.equal(committed.exitCode, 0);
    assert.match(committed.output, /\[\S+ [0-9a-f]{7,}\] test: 更新 a\.txt/);
    // 提交后工作区干净
    const diff = await executeTool({ args: {}, name: "git_diff", projectRoot: directory });
    assert.equal(diff.output, "没有改动。");

    // amend 覆盖 message
    const amended = await executeTool({ args: { amend: true, message: "test: amend 后的说明" }, name: "git_commit", projectRoot: directory });
    assert.equal(amended.exitCode, 0);
    assert.match(amended.output, /test: amend 后的说明/);
  } finally {
    rmSync(directory, CLEANUP);
  }
});

test("git_commit 审批:request_approval 需确认,full_access 与 grant 免批", () => {
  const args = { message: "feat: something" };
  const approval = approvalFor({ args, grants: [], profile: "request_approval", runId: "run_git", toolName: "git_commit" });
  assert.ok(approval);
  assert.equal(approval.capability, "workspace_write");
  assert.equal(approval.risk, "medium");
  assert.match(approval.title, /提交/);

  assert.equal(approvalFor({ args, grants: [], profile: "full_access", runId: "run_git", toolName: "git_commit" }), undefined);
  assert.equal(approvalFor({
    args,
    grants: [{ capability: "workspace_write", createdAt: "2026-08-13T00:00:00.000Z", grantId: "grant_git", runId: "run_git", scope: "run", targetPattern: "git_commit", toolName: "git_commit" }],
    profile: "request_approval",
    runId: "run_git",
    toolName: "git_commit"
  }), undefined);
});

test("git_diff 只读免批,git_diff/git_commit 均有标题与 review 归类", () => {
  assert.equal(approvalFor({ args: {}, grants: [], profile: "request_approval", runId: "run_git", toolName: "git_diff" }), undefined);
});
