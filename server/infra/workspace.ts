import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceInfo = {
  branch?: string;
  dirtyFiles: number;
  exists: boolean;
  git: boolean;
  name: string;
  projectRoot: string;
};

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
  const status = await git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    branch: branch || undefined,
    dirtyFiles: status ? status.split("\n").filter(Boolean).length : 0,
    exists: true,
    git: status !== undefined,
    name: path.basename(resolved),
    projectRoot: resolved
  };
}
