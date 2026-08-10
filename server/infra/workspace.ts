import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceFile, WorkspaceInfo, WorkspaceQueryPort } from "../app/workspaceQueries";
import { collectChanges } from "./tools/changes";
import { listArtifacts } from "./tools/files";

const execFileAsync = promisify(execFile);

async function git(projectRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      timeout: 5_000
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

export async function describeWorkspace(projectRoot: string): Promise<WorkspaceInfo> {
  const resolved = path.resolve(projectRoot);
  const exists = await fs.stat(resolved).then((entry) => entry.isDirectory()).catch(() => false);
  if (!exists) {
    return { dirtyFiles: 0, exists: false, git: false, name: path.basename(resolved), projectRoot: resolved };
  }
  const branch = await git(resolved, ["branch", "--show-current"]);
  const branchList = await git(resolved, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const status = await git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    branch: branch || undefined,
    branches: branchList ? branchList.split("\n").filter(Boolean) : undefined,
    dirtyFiles: status ? status.split("\n").filter(Boolean).length : 0,
    exists: true,
    git: status !== undefined,
    name: path.basename(resolved),
    projectRoot: resolved
  };
}

// 抛错版 git checkout:与上面吞错的 git() 不同,checkout 失败(如工作区有冲突改动、分支不存在)
// 必须把 stderr 透传给上层,由路由转成 4xx 让客户端提示。execFile 数组参无 shell 注入风险。
export async function checkoutBranch(projectRoot: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", projectRoot, "checkout", branch], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (error instanceof Error ? error.message : "git checkout 失败"));
  }
}

export async function readWorkspaceFile(projectRoot: string, relativePath: string, maxChars: number): Promise<WorkspaceFile> {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径必须位于项目根目录内。");
  }
  const contents = await fs.readFile(absolutePath, "utf8");
  return {
    content: contents.slice(0, maxChars),
    path: relativePath,
    projectRoot: root,
    truncated: contents.length > maxChars
  };
}

export const workspaceQueryPort: WorkspaceQueryPort = {
  checkout: checkoutBranch,
  collectHeadChanges: (projectRoot) => collectChanges(projectRoot),
  describe: describeWorkspace,
  listArtifacts: (projectRoot) => listArtifacts(projectRoot),
  readText: readWorkspaceFile
};
