import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ActivityKind,
  FileDeltaView,
  ToolAggregationPolicy,
  ToolDetailPolicy,
  ToolEffectKind,
  ToolExecutionView,
  ToolImportance,
  ToolOperationClass,
  ToolResourceKind,
  ToolResultMetrics,
  WorkspaceDeltaView
} from "../shared/runtimeTypes";
import { analyzeCommand } from "./permissionPolicy";
import { ToolDefinition } from "./providerTypes";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".deepseeker",
  ".playwright-cli",
  ".pytest_cache",
  ".venv",
  "dist",
  "node_modules",
  "output"
]);

export type RuntimeToolResult = {
  output: string;
  command?: string;
  exitCode?: number;
  mutatedWorkspace: boolean;
};

export type RuntimeToolProgress = {
  text: string;
};

type WorkspaceBaselineFile = {
  exists: boolean;
  snapshotPath?: string;
};

export type WorkspaceBaseline = {
  available: boolean;
  files: Map<string, WorkspaceBaselineFile>;
  snapshotDirectory: string;
};

type ToolPresentation = {
  aggregationPolicy: ToolAggregationPolicy;
  detailPolicy: ToolDetailPolicy;
  effectKind: ToolEffectKind;
  importance: ToolImportance;
  operationClass: ToolOperationClass;
  resourceKind: ToolResourceKind;
  resolveTarget: (args: Record<string, unknown>, projectRoot: string) => string;
  resolveSemantics?: (args: Record<string, unknown>) => Partial<Pick<ToolPresentation,
    "aggregationPolicy" | "effectKind" | "importance" | "operationClass" | "resourceKind"
  >>;
};

type RuntimeToolRegistration = ToolDefinition & {
  presentation: ToolPresentation;
};

const COLLAPSED_FILE_DETAIL: ToolDetailPolicy = {
  defaultCollapsed: true,
  pathStyle: "workspace_relative",
  previewLimit: 5
};

const COLLAPSED_RAW_DETAIL: ToolDetailPolicy = {
  defaultCollapsed: true,
  pathStyle: "raw",
  previewLimit: 5
};

function ensureInsideRoot(projectRoot: string, targetPath = "."): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径必须位于项目根目录内。");
  }
  return resolved;
}

function workspaceRelativeTarget(projectRoot: string, rawTarget: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, rawTarget || ".");
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return rawTarget;
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  return relative || ".";
}

function classifyCommand(command: string): Partial<ToolPresentation> {
  const semantics = analyzeCommand(command);
  const normalized = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  if (/^(?:rg|grep)\b/.test(normalized)) {
    return {
      aggregationPolicy: "consecutive",
      effectKind: "read_only",
      importance: "routine",
      operationClass: "search",
      resourceKind: "workspace"
    };
  }
  if (/^(?:cat|head|tail|sed\s+-n|ls|tree|find|fd|pwd|wc|git\s+(?:status|diff|log|show|branch))\b/.test(normalized)) {
    return {
      aggregationPolicy: "consecutive",
      effectKind: "read_only",
      importance: "routine",
      operationClass: "inspect",
      resourceKind: "workspace"
    };
  }
  if (/^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|check|typecheck))|npx\s+(?:tsc|eslint|vitest|playwright)|pytest|cargo\s+(?:test|check)|go\s+test)\b/.test(normalized)) {
    return {
      aggregationPolicy: "consecutive",
      effectKind: "process_side_effect",
      importance: "notable",
      operationClass: "verify",
      resourceKind: "process"
    };
  }
  if (semantics.readOnly) {
    return {
      aggregationPolicy: "consecutive",
      effectKind: "read_only",
      importance: "routine",
      operationClass: "inspect",
      resourceKind: "workspace"
    };
  }
  return {};
}

function isSensitivePath(targetPath: string): boolean {
  const base = path.basename(targetPath).toLowerCase();
  if (base === ".env.example") return false;
  return (
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === "credentials" ||
    base === "id_rsa" ||
    base.startsWith(".env") ||
    base.endsWith(".key") ||
    base.endsWith(".pem") ||
    base.includes("credentials") ||
    base.includes("secret")
  );
}

export function redactSensitiveText(text: string): string {
  let redacted = text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    redacted = redacted.split(value).join(`[REDACTED_${name}]`);
  }
  return redacted;
}

async function listFiles(projectRoot: string, input: { maxFiles?: number }): Promise<string> {
  const root = ensureInsideRoot(projectRoot);
  const output: string[] = [];
  const maxFiles = Math.min(1000, Math.max(1, input.maxFiles ?? 200));
  async function walk(current: string): Promise<void> {
    if (output.length >= maxFiles) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (output.length >= maxFiles) return;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (!entry.isDirectory() && isSensitivePath(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else output.push(path.relative(root, fullPath));
    }
  }
  await walk(root);
  return output.join("\n") || "项目目录中没有文件。";
}

async function readFile(projectRoot: string, input: { path: string; maxChars?: number }): Promise<string> {
  if (isSensitivePath(input.path)) throw new Error("出于安全原因，Runtime 不允许读取密钥或凭据文件。");
  const contents = await fs.readFile(ensureInsideRoot(projectRoot, input.path), "utf8");
  const maxChars = Math.min(200_000, Math.max(1, input.maxChars ?? 40_000));
  return contents.slice(0, maxChars);
}

async function writeFile(projectRoot: string, input: { path: string; content: string }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existed = await fs.access(filePath).then(() => true).catch(() => false);
  await fs.writeFile(filePath, input.content, "utf8");
  return `${existed ? "已编辑" : "已创建"} ${input.path}`;
}

async function editFile(
  projectRoot: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean }
): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const contents = await fs.readFile(filePath, "utf8");
  if (!input.oldText) throw new Error("oldText 不能为空。创建文件请使用 write_file。");
  const occurrences = contents.split(input.oldText).length - 1;
  if (occurrences === 0) throw new Error(`未在 ${input.path} 中找到 oldText。`);
  if (occurrences > 1 && !input.replaceAll) throw new Error(`oldText 在 ${input.path} 中出现 ${occurrences} 次，请提供更精确文本。`);
  const next = input.replaceAll ? contents.split(input.oldText).join(input.newText) : contents.replace(input.oldText, input.newText);
  await fs.writeFile(filePath, next, "utf8");
  return `已编辑 ${input.path}`;
}

async function deleteFile(projectRoot: string, input: { path: string }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("delete_file 只能删除文件。");
  await fs.unlink(filePath);
  return `已删除 ${input.path}`;
}

function runShell(
  projectRoot: string,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  onOutput?: (progress: RuntimeToolProgress) => void
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: ensureInsideRoot(projectRoot),
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 2_000_000) output = output.slice(-2_000_000);
      onOutput?.({ text: redactSensitiveText(text) });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 2_000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    const heartbeat = setInterval(() => onOutput?.({ text: "" }), 2_000);
    heartbeat.unref?.();
    const abort = terminate;
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new DOMException("运行已取消。", "AbortError"));
      const cleanedOutput = output.trimEnd();
      resolve({ exitCode: code ?? 1, output: redactSensitiveText(cleanedOutput || "命令执行完成，无输出。") });
    });
  });
}

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
    const [added, deleted, ...fileParts] = line.split("\t");
    result.set(fileParts.join("\t"), {
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0
    });
  }
  return result;
}

function operationForStatus(code: string): FileDeltaView["operation"] {
  if (code === "??" || code.includes("A")) return "created";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "edited";
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

export async function captureWorkspaceBaseline(projectRoot: string): Promise<WorkspaceBaseline> {
  const snapshotDirectory = await fs.mkdtemp(path.join(tmpdir(), "deepseeker-cycle-"));
  const baseline: WorkspaceBaseline = { available: false, files: new Map(), snapshotDirectory };
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

export async function checkpointWorkspaceTarget(
  projectRoot: string,
  baseline: WorkspaceBaseline,
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

export async function releaseWorkspaceBaseline(baseline: WorkspaceBaseline): Promise<void> {
  await fs.rm(baseline.snapshotDirectory, { force: true, recursive: true });
}

async function compareWithBaseline(
  projectRoot: string,
  filePath: string,
  baselineFile: WorkspaceBaselineFile
): Promise<FileDeltaView | undefined> {
  const currentPath = ensureInsideRoot(projectRoot, filePath);
  const currentExists = await fileExists(currentPath);
  if (!baselineFile.exists && !currentExists) return undefined;
  if (baselineFile.exists && currentExists && baselineFile.snapshotPath) {
    const [before, after] = await Promise.all([fs.readFile(baselineFile.snapshotPath), fs.readFile(currentPath)]);
    if (before.equals(after)) return undefined;
  }
  const beforePath = baselineFile.exists && baselineFile.snapshotPath ? baselineFile.snapshotPath : "/dev/null";
  const afterPath = currentExists ? currentPath : "/dev/null";
  const [numstatResult, patchResult] = await Promise.all([
    runShell(projectRoot, `git diff --no-index --numstat -- ${JSON.stringify(beforePath)} ${JSON.stringify(afterPath)}`),
    runShell(projectRoot, `git diff --no-index -- ${JSON.stringify(beforePath)} ${JSON.stringify(afterPath)}`)
  ]);
  const counts = [...parseNumstat(numstatResult.output).values()][0] ?? { additions: 0, deletions: 0 };
  const patch = patchResult.output === "命令执行完成，无输出。"
    ? undefined
    : patchResult.output
        .replaceAll(beforePath, `a/${filePath}`)
        .replaceAll(afterPath, `b/${filePath}`);
  return {
    ...counts,
    operation: !baselineFile.exists ? "created" : !currentExists ? "deleted" : "edited",
    patch,
    path: filePath
  };
}

export async function collectWorkspaceDelta(
  projectRoot: string,
  baseline?: WorkspaceBaseline
): Promise<WorkspaceDeltaView> {
  const comparisonBase = baseline ? "cycle_start" as const : "git_head" as const;
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
    const files: FileDeltaView[] = [];
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
        let counts = stats.get(filePath) ?? { additions: 0, deletions: 0 };
        if (entry.code === "??") {
          const text = await fs.readFile(ensureInsideRoot(projectRoot, filePath), "utf8").catch(() => "");
          counts = { additions: text ? text.split("\n").length : 0, deletions: 0 };
        }
        files.push({ ...counts, operation: operationForStatus(entry.code), path: filePath });
      }
    } else {
      for (const { code, path: filePath } of statusEntries) {
        let counts = stats.get(filePath) ?? { additions: 0, deletions: 0 };
        if (code === "??") {
          const text = await fs.readFile(ensureInsideRoot(projectRoot, filePath), "utf8").catch(() => "");
          counts = { additions: text ? text.split("\n").length : 0, deletions: 0 };
        }
        const patch = code === "??" ? undefined : (await runShell(projectRoot, `git diff HEAD -- ${JSON.stringify(filePath)}`)).output;
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

export function summarizeToolArguments(name: string, args: Record<string, unknown>): string {
  const safe = { ...args };
  if (name === "write_file" && typeof safe.content === "string") {
    safe.content = `[文件内容已从事件日志省略，共 ${safe.content.length} 字符]`;
  }
  if (name === "edit_file") {
    if (typeof safe.oldText === "string") safe.oldText = `[原文本已省略，共 ${safe.oldText.length} 字符]`;
    if (typeof safe.newText === "string") safe.newText = `[新文本已省略，共 ${safe.newText.length} 字符]`;
  }
  return redactSensitiveText(JSON.stringify(safe));
}

export function summarizeToolResult(name: string, args: Record<string, unknown>, output: string): string {
  if (name === "read_file") return `已读取 ${String(args.path ?? "文件")}`;
  if (name === "list_files") {
    const count = output.split("\n").filter(Boolean).length;
    return `已列出 ${count} 个项目文件`;
  }
  return redactSensitiveText(output).slice(0, 2_000);
}

export async function executeRuntimeTool(input: {
  projectRoot: string;
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onOutput?: (progress: RuntimeToolProgress) => void;
}): Promise<RuntimeToolResult> {
  const { projectRoot, name, args, signal, onOutput } = input;
  if (name === "list_files") return { mutatedWorkspace: false, output: await listFiles(projectRoot, args) };
  if (name === "read_file") return { mutatedWorkspace: false, output: await readFile(projectRoot, args as never) };
  if (name === "git_status") {
    const result = await runShell(projectRoot, "git status --short && git diff --stat", signal);
    return { ...result, mutatedWorkspace: false };
  }
  if (name === "write_file") return { mutatedWorkspace: true, output: await writeFile(projectRoot, args as never) };
  if (name === "edit_file") return { mutatedWorkspace: true, output: await editFile(projectRoot, args as never) };
  if (name === "delete_file") return { mutatedWorkspace: true, output: await deleteFile(projectRoot, args as never) };
  if (name === "run_command") {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("command 不能为空。");
    const result = await runShell(projectRoot, command, signal, 120_000, onOutput);
    return { ...result, command, mutatedWorkspace: !analyzeCommand(command).readOnly };
  }
  throw new Error(`未知工具：${name}`);
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
  type: "object"
});

const runtimeToolRegistry: RuntimeToolRegistration[] = [
  {
    name: "list_files",
    description: "列出项目文件，忽略依赖、Git 和构建目录。",
    inputSchema: objectSchema({ maxFiles: { type: "number" } }),
    presentation: {
      aggregationPolicy: "consecutive",
      detailPolicy: COLLAPSED_FILE_DETAIL,
      effectKind: "read_only",
      importance: "routine",
      operationClass: "inspect",
      resourceKind: "directory",
      resolveTarget: (_args, projectRoot) => workspaceRelativeTarget(projectRoot, ".")
    }
  },
  {
    name: "read_file",
    description: "读取项目根目录内的 UTF-8 文本文件。",
    inputSchema: objectSchema({ path: { type: "string" }, maxChars: { type: "number" } }, ["path"]),
    presentation: {
      aggregationPolicy: "consecutive",
      detailPolicy: COLLAPSED_FILE_DETAIL,
      effectKind: "read_only",
      importance: "routine",
      operationClass: "inspect",
      resourceKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    name: "git_status",
    description: "读取工作区 Git 状态和差异摘要。",
    inputSchema: objectSchema({}),
    presentation: {
      aggregationPolicy: "consecutive",
      detailPolicy: COLLAPSED_RAW_DETAIL,
      effectKind: "read_only",
      importance: "routine",
      operationClass: "inspect",
      resourceKind: "workspace",
      resolveTarget: () => "Git 工作区"
    }
  },
  {
    name: "write_file",
    description: "创建文件或用完整内容覆盖现有文件。",
    inputSchema: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    presentation: {
      aggregationPolicy: "workspace_delta",
      detailPolicy: COLLAPSED_FILE_DETAIL,
      effectKind: "workspace_write",
      importance: "notable",
      operationClass: "modify",
      resourceKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    name: "edit_file",
    description: "通过精确文本替换编辑现有文件。",
    inputSchema: objectSchema({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, ["path", "oldText", "newText"]),
    presentation: {
      aggregationPolicy: "workspace_delta",
      detailPolicy: COLLAPSED_FILE_DETAIL,
      effectKind: "workspace_write",
      importance: "notable",
      operationClass: "modify",
      resourceKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    name: "delete_file",
    description: "删除项目根目录内的单个文件，需要用户批准。",
    inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
    presentation: {
      aggregationPolicy: "standalone",
      detailPolicy: { ...COLLAPSED_FILE_DETAIL, defaultCollapsed: false },
      effectKind: "workspace_write",
      importance: "critical",
      operationClass: "modify",
      resourceKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    name: "run_command",
    description: "在项目根目录运行 shell 命令。非安全命令需要用户批准。",
    inputSchema: objectSchema({ command: { type: "string" } }, ["command"]),
    presentation: {
      aggregationPolicy: "standalone",
      detailPolicy: COLLAPSED_RAW_DETAIL,
      effectKind: "process_side_effect",
      importance: "notable",
      operationClass: "execute",
      resourceKind: "process",
      resolveSemantics: (args) => classifyCommand(String(args.command ?? "")),
      resolveTarget: (args) => String(args.command ?? "")
    }
  },
  {
    name: "update_plan",
    description: "建立或替换当前工作周期的任务计划。简单问答不要调用。",
    inputSchema: objectSchema(
      {
        steps: {
          items: objectSchema(
            {
              label: { type: "string" },
              state: { enum: ["pending", "in_progress", "completed", "blocked"], type: "string" },
              stepKey: { type: "string" }
            },
            ["stepKey", "label", "state"]
          ),
          minItems: 1,
          type: "array"
        }
      },
      ["steps"]
    ),
    presentation: {
      aggregationPolicy: "standalone",
      detailPolicy: COLLAPSED_RAW_DETAIL,
      effectKind: "control_only",
      importance: "routine",
      operationClass: "plan",
      resourceKind: "plan",
      resolveTarget: () => "当前计划"
    }
  }
];

export const runtimeToolDefinitions: ToolDefinition[] = runtimeToolRegistry.map(
  ({ description, inputSchema, name }) => ({ description, inputSchema, name })
);

function registrationFor(name: string): RuntimeToolRegistration {
  const registration = runtimeToolRegistry.find((tool) => tool.name === name);
  if (!registration) throw new Error(`未知工具：${name}`);
  return registration;
}

export function hasRuntimeTool(name: string): boolean {
  return runtimeToolRegistry.some((tool) => tool.name === name);
}

export function runtimeToolNames(): string[] {
  return runtimeToolRegistry.map((tool) => tool.name);
}

export function createToolExecutionView(input: {
  args?: Record<string, unknown>;
  argumentsPreview?: string;
  callKey: string;
  modelStepKey: string;
  name: string;
  projectRoot: string;
  result?: RuntimeToolResult;
  output?: string;
}): ToolExecutionView {
  const registration = registrationFor(input.name);
  const args = input.args ?? {};
  const overrides = registration.presentation.resolveSemantics?.(args) ?? {};
  const presentation = { ...registration.presentation, ...overrides };
  const target = presentation.resolveTarget(args, input.projectRoot);
  return {
    aggregationPolicy: presentation.aggregationPolicy,
    argumentsPreview: input.argumentsPreview ?? "",
    callKey: input.callKey,
    detailPolicy: presentation.detailPolicy,
    displayTarget: target,
    effectKind: presentation.effectKind,
    importance: presentation.importance,
    modelStepKey: input.modelStepKey,
    normalizedTarget: target.trim().replaceAll("\\", "/"),
    operationClass: presentation.operationClass,
    resourceKind: presentation.resourceKind,
    resultMetrics: input.result && input.output
      ? resultMetricsFor(input.name, args, input.output, input.result, presentation.operationClass)
      : undefined,
    resultSummary: input.output ? summarizeToolResult(input.name, args, input.output).slice(0, 500) : undefined,
    toolName: input.name
  };
}

function resultMetricsFor(
  name: string,
  args: Record<string, unknown>,
  output: string,
  result: RuntimeToolResult,
  operationClass: ToolOperationClass
): ToolResultMetrics {
  const lines = output.split("\n").filter(Boolean).length;
  return {
    byteCount: Buffer.byteLength(output),
    exitCode: result.exitCode,
    itemCount: name === "list_files" ? lines : name === "read_file" || operationClass === "modify" ? 1 : undefined,
    matchCount: operationClass === "search" ? lines : undefined,
    truncated: name === "read_file" && output.length >= Number(args.maxChars ?? 40_000)
  };
}

export function activityKindForTool(tool: ToolExecutionView): ActivityKind {
  if (tool.operationClass === "modify") return "file_mutation";
  if (tool.operationClass === "execute" || tool.operationClass === "verify") return "command";
  return "tool";
}

export function toolTitle(name: string): string {
  return ({
    delete_file: "删除文件",
    edit_file: "编辑文件",
    git_status: "检查 Git 状态",
    list_files: "列出项目文件",
    read_file: "读取文件",
    run_command: "运行命令",
    update_plan: "更新计划",
    write_file: "写入文件"
  } as Record<string, string>)[name] ?? name;
}
