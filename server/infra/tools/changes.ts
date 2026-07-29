import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Changes, FileChange } from "../../../shared/contracts/runtime";
import { Baseline, BaselineFile } from "../../../shared/contracts/tool";
import { quoteRuntimeShellArgument, resolveRuntimeShell } from "../shell";
import { ensureInsideRoot, workspaceRelativeTarget } from "./security";
import { runShell } from "./shellExecution";

type StatusEntry = { code: string; path: string };

function parseStatus(output: string): StatusEntry[] {
  return output.split("\n").flatMap((line) => {
    if (!line || line.startsWith("命令执行")) return [];
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    return filePath ? [{ code, path: filePath }] : [];
  });
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n").filter(Boolean)) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    result.set(match[3], {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2])
    });
  }
  return result;
}

function textLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function normalizePatch(
  output: string,
  filePath: string,
  beforeExists: boolean,
  afterExists: boolean
): string | undefined {
  const lines = output.split("\n").filter((line) => !line.startsWith("warning: "));
  if (lines.length === 0 || !lines.some((line) => line.startsWith("diff --git "))) return undefined;
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) return `diff --git a/${filePath} b/${filePath}`;
    if (line.startsWith("--- ")) return beforeExists ? `--- a/${filePath}` : "--- /dev/null";
    if (line.startsWith("+++ ")) return afterExists ? `+++ b/${filePath}` : "+++ /dev/null";
    return line;
  }).join("\n");
}

function operationForStatus(code: string): FileChange["operation"] {
  if (code === "??" || code.includes("A")) return "created";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "edited";
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

export async function captureBaseline(projectRoot: string): Promise<Baseline> {
  const snapshotDirectory = await fs.mkdtemp(path.join(tmpdir(), "deepcreator-run-"));
  const baseline: Baseline = { available: false, files: new Map(), leases: 1, released: false, snapshotDirectory };
  const statusResult = await runShell(
    projectRoot,
    "git -c core.quotepath=false -c status.renames=false status --porcelain=v1 --untracked-files=all"
  );
  if (statusResult.exitCode !== 0) return baseline;
  baseline.available = true;
  const entries = parseStatus(statusResult.output);
  for (const [index, entry] of entries.entries()) {
    const sourcePath = ensureInsideRoot(projectRoot, entry.path);
    const exists = await fileExists(sourcePath);
    if (!exists) {
      baseline.files.set(entry.path, { exists: false });
      continue;
    }
    const snapshotPath = path.join(snapshotDirectory, String(index));
    await fs.copyFile(sourcePath, snapshotPath);
    baseline.files.set(entry.path, { exists: true, snapshotPath });
  }
  return baseline;
}

export async function checkpointTarget(
  projectRoot: string,
  baseline: Baseline,
  rawTarget: string
): Promise<void> {
  if (!baseline.available) return;
  const absolutePath = ensureInsideRoot(projectRoot, rawTarget);
  const relativePath = workspaceRelativeTarget(projectRoot, rawTarget);
  if (baseline.files.has(relativePath)) return;
  const exists = await fileExists(absolutePath);
  if (!exists) {
    baseline.files.set(relativePath, { exists: false });
    return;
  }
  const snapshotPath = path.join(baseline.snapshotDirectory, `direct-${baseline.files.size}-${path.basename(relativePath)}`);
  await fs.copyFile(absolutePath, snapshotPath);
  baseline.files.set(relativePath, { exists: true, snapshotPath });
}

export async function releaseBaseline(baseline: Baseline): Promise<void> {
  if (baseline.released) return;
  baseline.leases = Math.max(0, baseline.leases - 1);
  if (baseline.leases > 0) return;
  baseline.released = true;
  await fs.rm(baseline.snapshotDirectory, { force: true, recursive: true });
}

export function retainBaseline(baseline: Baseline): void {
  if (baseline.released) throw new Error("命令无法保留已经释放的工作区基线。");
  baseline.leases += 1;
}

async function compareWithBaseline(
  projectRoot: string,
  filePath: string,
  baselineFile: BaselineFile
): Promise<FileChange | undefined> {
  const currentPath = ensureInsideRoot(projectRoot, filePath);
  const currentExists = await fileExists(currentPath);
  if (!baselineFile.exists && !currentExists) return undefined;
  if (baselineFile.exists && currentExists && baselineFile.snapshotPath) {
    const [before, after] = await Promise.all([fs.readFile(baselineFile.snapshotPath), fs.readFile(currentPath)]);
    if (before.equals(after)) return undefined;
  }
  const nullPath = process.platform === "win32" && resolveRuntimeShell().family !== "bash" ? "NUL" : "/dev/null";
  const beforePath = baselineFile.exists && baselineFile.snapshotPath ? baselineFile.snapshotPath : nullPath;
  const afterPath = currentExists ? currentPath : nullPath;
  const beforeArgument = quoteRuntimeShellArgument(beforePath);
  const afterArgument = quoteRuntimeShellArgument(afterPath);
  const [numstatResult, patchResult] = await Promise.all([
    runShell(projectRoot, `git -c core.autocrlf=false diff --no-index --numstat -- ${beforeArgument} ${afterArgument}`),
    runShell(projectRoot, `git -c core.autocrlf=false diff --no-index -- ${beforeArgument} ${afterArgument}`)
  ]);
  const counts = [...parseNumstat(numstatResult.output).values()][0] ?? { additions: 0, deletions: 0 };
  const patch = normalizePatch(patchResult.output, filePath, baselineFile.exists, currentExists);
  return {
    ...counts,
    operation: !baselineFile.exists ? "created" : !currentExists ? "deleted" : "edited",
    patch,
    path: filePath
  };
}

export async function collectChanges(
  projectRoot: string,
  baseline?: Baseline
): Promise<Changes> {
  const comparisonBase = baseline ? "run_start" as const : "git_head" as const;
  try {
    const [statusResult, numstatResult] = await Promise.all([
      runShell(projectRoot, "git -c core.quotepath=false -c status.renames=false status --porcelain=v1 --untracked-files=all"),
      runShell(projectRoot, "git -c core.quotepath=false diff --no-renames HEAD --numstat")
    ]);
    if (statusResult.exitCode !== 0) {
      return { additions: 0, capturedAt: new Date().toISOString(), comparisonBase, deletions: 0, fileCount: 0, files: [] };
    }
    const stats = parseNumstat(numstatResult.output);
    const statusEntries = parseStatus(statusResult.output);
    const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
    const files: FileChange[] = [];
    if (baseline?.available) {
      const paths = new Set([...baseline.files.keys(), ...statusByPath.keys()]);
      for (const filePath of paths) {
        const baselineFile = baseline.files.get(filePath);
        if (baselineFile) {
          const delta = await compareWithBaseline(projectRoot, filePath, baselineFile);
          if (delta) files.push(delta);
          continue;
        }
        const entry = statusByPath.get(filePath);
        if (!entry) continue;
        if (entry.code === "??") {
          const delta = await compareWithBaseline(projectRoot, filePath, { exists: false });
          if (delta) files.push(delta);
          continue;
        }
        const counts = stats.get(filePath) ?? { additions: 0, deletions: 0 };
        files.push({ ...counts, operation: operationForStatus(entry.code), path: filePath });
      }
    } else {
      for (const { code, path: filePath } of statusEntries) {
        let counts = stats.get(filePath) ?? { additions: 0, deletions: 0 };
        if (code === "??") {
          const text = await fs.readFile(ensureInsideRoot(projectRoot, filePath), "utf8").catch(() => "");
          counts = { additions: textLineCount(text), deletions: 0 };
        }
        const patch = code === "??" ? undefined : (await runShell(projectRoot, `git diff HEAD -- ${quoteRuntimeShellArgument(filePath)}`)).output;
        files.push({ ...counts, operation: operationForStatus(code), patch: patch === "命令执行完成，无输出。" ? undefined : patch, path: filePath });
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      capturedAt: new Date().toISOString(),
      comparisonBase,
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      fileCount: files.length,
      files
    };
  } catch {
    return { additions: 0, capturedAt: new Date().toISOString(), comparisonBase, deletions: 0, fileCount: 0, files: [] };
  }
}


