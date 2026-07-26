import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ActivityKind,
  FileChange,
  Effect,
  ToolState,
  ActionKind,
  TargetKind,
  ToolMetrics,
  Changes
} from "../../shared/contracts/runtime";
import { DetailMode, GroupMode, ToolImportance } from "../../shared/projections/types";
import { analyzeCommand } from "../domain/accessPolicy";
import { ToolSpec } from "../../shared/contracts/provider";
import { Baseline, BaselineFile, ToolProgress, ToolResult } from "../../shared/contracts/tool";
import { PreparedToolState, ToolHost } from "../app/toolHost";
import { invokeCapability, searchCapabilities } from "./capabilities";
import { quoteRuntimeShellArgument, resolveRuntimeShell } from "./shell";
import { commandManager, CommandSnapshot } from "./commandManager";
import { Minimatch } from "minimatch";
import safeRegex from "safe-regex2";
import {
  ensureInsideRoot,
  isSensitivePath,
  redactSensitiveText,
  workspaceRelativeTarget
} from "./tools/security";
import { summarizeToolArguments, summarizeToolResult } from "./tools/summaries";
import { runShell } from "./tools/shellExecution";
import { deleteFile, editFile, listFiles, multiEdit, readFile, writeFile } from "./tools/files";

export { redactSensitiveText } from "./tools/security";
export { summarizeToolArguments, summarizeToolResult } from "./tools/summaries";

const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_BINARY_SAMPLE_BYTES = 8 * 1024;
const GREP_MAX_PATTERN_CHARS = 2_000;

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

type ToolPresentation = {
  groupMode: GroupMode;
  detail: DetailMode;
  effect: Effect;
  importance: ToolImportance;
  action: ActionKind;
  targetKind: TargetKind;
  resolveTarget: (args: Record<string, unknown>, projectRoot: string) => string;
  resolveSemantics?: (args: Record<string, unknown>) => Partial<Pick<ToolPresentation,
    "groupMode" | "effect" | "importance" | "action" | "targetKind"
  >>;
};

type ToolRegistration = ToolSpec & {
  presentation: ToolPresentation;
};

const COLLAPSED_FILE_DETAIL: DetailMode = {
  defaultCollapsed: true,
  pathStyle: "workspace_relative",
  previewLimit: 5
};

const COLLAPSED_RAW_DETAIL: DetailMode = {
  defaultCollapsed: true,
  pathStyle: "raw",
  previewLimit: 5
};

function classifyCommand(command: string): Partial<ToolPresentation> {
  const semantics = analyzeCommand(command);
  const normalized = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  if (/^(?:rg|grep)\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace"
    };
  }
  if (/^(?:cat|head|tail|sed\s+-n|ls|tree|find|fd|pwd|wc|git\s+(?:status|diff|log|show|branch))\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace"
    };
  }
  if (/^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|check|typecheck))|npx\s+(?:tsc|eslint|vitest|playwright)|pytest|cargo\s+(?:test|check)|go\s+test)\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "process_side_effect",
      importance: "notable",
      action: "verify",
      targetKind: "process"
    };
  }
  if (semantics.readOnly) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace"
    };
  }
  return {};
}

// grep 工具:在项目文件中按正则搜索内容。纯 Node 实现,不依赖外部 rg。
// 安全约束:① 跳过 IGNORED_DIRECTORIES ② 搜索前用 isSensitivePath 排除密钥文件
//         ③ 输出整体过 redactSensitiveText 兜底 ④ 响应 AbortSignal
type GrepHit = {
  path: string;
  line: number;
  column: number;
  match: string;
  contextBefore: string[];
  contextAfter: string[];
};

// grep 工具的输入(含 fixed_strings 与 case_sensitive 等开关)
// output_mode 三档:files_with_matches(默认,只返回路径)/ content(返回 path:line:content)/
//                  count(返回每个文件的命中数)/ json(结构化字段)
type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "files_with_matches" | "content" | "count" | "json";
  case_sensitive?: boolean;
  context?: number;
  max_results?: number;
  fixed_strings?: boolean;
};

// 匹配 PCRE / Oniguruma / Java / .NET 风格的内联标志,JS RegExp 不支持这些写法。
// 形如 (?i)、(?-i)、(?im)、(?i:foo)、(?-i:foo)。捕获组 1 是标志字母,组 2 是可选的组体。
const INLINE_FLAG_PATTERN = /\(\?([a-z?-]+)(?::([^)]*))?\)/g;

// 把外部正则方言(尤其 (?i) 内联标志)归一化为 JS RegExp 兼容形式。
// 返回编译后的 RegExp 和可能产生的警告(用于让模型知道发生了什么转换)。
function compileGrepPattern(input: GrepInput): { regex: RegExp; warnings: string[] } {
  const warnings: string[] = [];
  const raw = input.pattern;
  if (raw.length > GREP_MAX_PATTERN_CHARS) {
    throw new Error(`正则表达式过长，最多允许 ${GREP_MAX_PATTERN_CHARS} 个字符。请缩短 pattern。`);
  }

  const validate = (regex: RegExp): RegExp => {
    if (!safeRegex(regex)) {
      throw new Error("正则表达式可能产生灾难性回溯，已拒绝执行。请简化 pattern，或使用 fixed_strings=true 搜索字面量。");
    }
    return regex;
  };

  // fixed_strings 模式:整体当作字面量,转义所有正则元字符(等价于 rg -F)
  if (input.fixed_strings) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return { regex: validate(new RegExp(escaped, input.case_sensitive ? "g" : "gi")), warnings };
    } catch (error) {
      throw new Error(
        `无法编译字面量搜索：${raw}（${error instanceof Error ? error.message : String(error)}）。请尝试更换 pattern 或使用更短的字符串。`
      );
    }
  }

  // 归一化内联标志:剥离 (?i) / (?-i) / (?im) / (?i:foo) 这类 JS 不支持的语法,
  // 把大小写不敏感语义合并到外部 flags。其他标志(m/s)JS 都支持,直接合并。
  let pattern = raw;
  let externalFlags = input.case_sensitive ? "g" : "gi";
  // 用局部 regex 避免全局正则的 lastIndex 状态陷阱
  const flagScanner = new RegExp(INLINE_FLAG_PATTERN.source, "g");
  if (flagScanner.test(pattern)) {
    flagScanner.lastIndex = 0;
    let transformed = "";
    let lastIndex = 0;
    let caseInsensitiveSeen = false;
    let negatedSeen: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = flagScanner.exec(pattern)) !== null) {
      transformed += pattern.slice(lastIndex, match.index);
      const [whole, flagChars, groupBody] = match;
      const lowerFlags = (flagChars ?? "").toLowerCase();
      if (flagChars && flagChars.includes("-")) {
        // (?-i) 取反标志,JS 不支持,直接剥离并记录
        negatedSeen.push(whole);
      } else if (lowerFlags.includes("i")) {
        // (?i) 或 (?i:...) 表示模式内部要求大小写不敏感。
        // 仅当用户没有显式要求 case_sensitive=true 时才合并到外部 i 标志——
        // 显式参数优先级高于 pattern 里的方言污染,保证契约可预测。
        if (!input.case_sensitive) caseInsensitiveSeen = true;
      }
      // 其他标志(m/s/x 等):JS 支持 m 和 s,x 不支持。统一剥离外层 (?...) 语法,
      // 如果带组体 (?i:foo) 则保留组体为非捕获组
      if (groupBody !== undefined) {
        transformed += `(?:${groupBody})`;
      }
      lastIndex = match.index + whole.length;
    }
    transformed += pattern.slice(lastIndex);
    pattern = transformed;
    if (caseInsensitiveSeen) {
      externalFlags = "gi";
      warnings.push("已把内联 (?i) 标志转换为外部大小写不敏感(等价于 case_sensitive=false)。");
    }
    for (const neg of negatedSeen) {
      warnings.push(`已剥离 JS 不支持的取反内联标志 ${neg}。如需精确控制大小写,请改用 case_sensitive 参数。`);
    }
  }

  try {
    return { regex: validate(new RegExp(pattern, externalFlags)), warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无效的正则表达式：${raw}（${detail}）。` +
        `提示:JS RegExp 不支持 (?i) 等 PCRE 内联标志,可用 case_sensitive=false 替代;` +
        `或加 fixed_strings=true 把 pattern 当作字面量搜索。`
    );
  }
}

async function grepFiles(
  projectRoot: string,
  input: GrepInput,
  signal?: AbortSignal
): Promise<string> {
  const workspaceRoot = path.resolve(projectRoot);
  const root = ensureInsideRoot(workspaceRoot, input.path ?? ".");
  const { regex, warnings } = compileGrepPattern(input);
  const globFilter = input.glob ? new Minimatch(input.glob, { dot: false }) : null;
  const maxFiles = Math.min(1000, Math.max(1, input.max_results ?? 200));
  const contextLines = Math.min(3, Math.max(0, input.context ?? 0));
  // output_mode 四档:默认 files_with_matches(只返回路径,省 token)
  const mode = input.output_mode ?? "files_with_matches";
  const wantContent = mode === "content";
  const wantCount = mode === "count";
  const wantJson = mode === "json";
  // files_with_matches 模式每个文件最多 1 条记录,content/count/json 模式才需要逐行收
  // 这里 maxFiles 对 content/json 仍表示"最大命中行数";对 files_with_matches/count 表示"最大文件数"
  const maxLineHits = wantContent || wantJson ? maxFiles : Number.MAX_SAFE_INTEGER;

  const hits: GrepHit[] = [];
  const contentLines: string[] = [];
  const matchedFiles: string[] = [];
  const fileCounts: { path: string; count: number }[] = [];
  let lineHitCount = 0;
  let fileHitCount = 0;
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;

  async function walk(current: string): Promise<void> {
    if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    // files_with_matches/count 模式按文件数截断;content/json 按行数截断
    if ((wantContent || wantJson) && lineHitCount >= maxLineHits) return;
    if ((mode === "files_with_matches" || wantCount) && fileHitCount >= maxFiles) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
      if ((wantContent || wantJson) && lineHitCount >= maxLineHits) return;
      if ((mode === "files_with_matches" || wantCount) && fileHitCount >= maxFiles) return;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const matchPath = path.relative(root, fullPath).replaceAll("\\", "/");
      const relativePath = path.relative(workspaceRoot, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      // 安全:搜索前排除敏感文件(.env / *.key / id_rsa 等)
      if (isSensitivePath(entry.name)) continue;
      if (globFilter && !globFilter.match(matchPath)) continue;
      let contents: string;
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        if (stat.size > GREP_MAX_FILE_BYTES) {
          skippedLargeFiles += 1;
          continue;
        }
        const buffer = await fs.readFile(fullPath);
        if (buffer.byteLength > GREP_MAX_FILE_BYTES) {
          skippedLargeFiles += 1;
          continue;
        }
        if (buffer.subarray(0, GREP_BINARY_SAMPLE_BYTES).includes(0)) {
          skippedBinaryFiles += 1;
          continue;
        }
        contents = buffer.toString("utf8");
      } catch {
        // 二进制或无权限文件,跳过
        continue;
      }
      const lines = contents.split("\n");
      let fileMatches = 0;
      for (let i = 0; i < lines.length; i++) {
        if (wantContent || wantJson) {
          if (lineHitCount >= maxLineHits) break;
        }
        regex.lastIndex = 0;
        const match = regex.exec(lines[i]);
        if (!match) continue;
        fileMatches += 1;
        // files_with_matches 模式:本文件已有命中即可,记录后跳出本文件
        if (mode === "files_with_matches") break;
        if (wantCount) continue; // count 模式只累加 fileMatches,不存行
        lineHitCount += 1;
        const contextBefore = contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : [];
        const contextAfter = contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines) : [];
        if (wantJson) {
          hits.push({
            path: relativePath,
            line: i + 1,
            column: match.index + 1,
            match: match[0],
            contextBefore,
            contextAfter
          });
        } else if (wantContent) {
          contentLines.push(`${relativePath}:${i + 1}:${lines[i]}`);
        }
      }
      if (fileMatches > 0) {
        fileHitCount += 1;
        if (mode === "files_with_matches") {
          matchedFiles.push(relativePath);
        } else if (wantCount) {
          fileCounts.push({ path: relativePath, count: fileMatches });
        }
      }
    }
  }

  await walk(root);

  const scanWarnings = [
    skippedLargeFiles > 0 ? `已跳过 ${skippedLargeFiles} 个超过 ${GREP_MAX_FILE_BYTES / 1024 / 1024} MiB 的文件` : "",
    skippedBinaryFiles > 0 ? `已跳过 ${skippedBinaryFiles} 个二进制文件` : ""
  ].filter(Boolean);
  if (fileHitCount === 0 && lineHitCount === 0) {
    const notes = [
      warnings.length > 0 ? `正则已归一化：${warnings.join(" ")}` : "",
      ...scanWarnings
    ].filter(Boolean);
    const noHitWarning = notes.length > 0
      ? `未找到匹配内容。\n\n(${notes.join("；")})`
      : "未找到匹配内容。";
    return noHitWarning;
  }

  // 构造输出 body
  let body: string;
  let truncatedNote = "";
  if (mode === "files_with_matches") {
    body = matchedFiles.join("\n");
    if (fileHitCount >= maxFiles) truncatedNote = `已截断，仅显示前 ${maxFiles} 个文件`;
  } else if (wantCount) {
    body = fileCounts.map((f) => `${f.path}:${f.count}`).join("\n");
    if (fileHitCount >= maxFiles) truncatedNote = `已截断，仅显示前 ${maxFiles} 个文件`;
  } else if (wantJson) {
    body = JSON.stringify(hits, null, 2);
    if (lineHitCount >= maxLineHits) truncatedNote = `已截断，仅显示前 ${maxLineHits} 条命中`;
  } else {
    // content
    body = contentLines.join("\n");
    if (lineHitCount >= maxLineHits) truncatedNote = `已截断，仅显示前 ${maxLineHits} 条命中`;
  }
  const notes: string[] = [];
  if (truncatedNote) notes.push(`${truncatedNote}。如需更多，请收窄 pattern 或 glob 范围。`);
  if (warnings.length > 0) notes.push(`正则已归一化：${warnings.join(" ")}`);
  notes.push(...scanWarnings);
  const suffix = notes.length > 0 ? `\n\n(${notes.join("；")})` : "";
  return redactSensitiveText(body + suffix);
}

// glob 工具:按 minimatch 模式匹配项目文件路径。复用 minimatch(已是直接依赖)。
type GlobInput = {
  pattern: string;
  path?: string;
  detail?: boolean;
  limit?: number;
};

async function globFiles(
  projectRoot: string,
  input: GlobInput,
  signal?: AbortSignal
): Promise<string> {
  const workspaceRoot = path.resolve(projectRoot);
  const root = ensureInsideRoot(workspaceRoot, input.path ?? ".");
  let matcher: Minimatch;
  try {
    matcher = new Minimatch(input.pattern, { dot: false });
  } catch (error) {
    throw new Error(`无效的 glob 模式：${input.pattern}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const limit = Math.min(1000, Math.max(1, input.limit ?? 200));
  const withDetail = input.detail === true;

  // 同时记录路径和 mtime,用于按修改时间倒序排列(最近改过的文件排前面,
  // 对齐 Claude Code Glob 工具的 "sorted by modification time" 行为)
  type Entry = { path: string; size?: number; mtime?: number };
  const matched: Entry[] = [];
  let matchCount = 0;

  const isWorse = (left: Entry, right: Entry): boolean => {
    const leftMtime = left.mtime ?? 0;
    const rightMtime = right.mtime ?? 0;
    if (leftMtime !== rightMtime) return leftMtime < rightMtime;
    return left.path.localeCompare(right.path) > 0;
  };
  const pushLatest = (record: Entry): void => {
    matchCount += 1;
    if (matched.length < limit) {
      matched.push(record);
      let index = matched.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!isWorse(matched[index], matched[parent])) break;
        [matched[index], matched[parent]] = [matched[parent], matched[index]];
        index = parent;
      }
      return;
    }
    if (isWorse(record, matched[0])) return;
    matched[0] = record;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < matched.length && isWorse(matched[left], matched[worst])) worst = left;
      if (right < matched.length && isWorse(matched[right], matched[worst])) worst = right;
      if (worst === index) break;
      [matched[index], matched[worst]] = [matched[worst], matched[index]];
      index = worst;
    }
  };

  async function walk(current: string): Promise<void> {
    if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const matchPath = path.relative(root, fullPath).replaceAll("\\", "/");
      const relativePath = path.relative(workspaceRoot, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (isSensitivePath(entry.name)) continue;
      if (!matcher.match(matchPath)) continue;
      // 即便不需要 detail,也要取 mtime 用于排序(单次 stat 开销可接受)
      try {
        const stat = await fs.stat(fullPath);
        const record: Entry = { path: relativePath, mtime: stat.mtimeMs };
        if (withDetail) record.size = stat.size;
        pushLatest(record);
      } catch {
        pushLatest({ path: relativePath });
      }
    }
  }

  await walk(root);

  if (matched.length === 0) return "未匹配到任何文件。";
  // 按 mtime 倒序排(最近修改的在前);无 mtime 的排最后
  matched.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.path.localeCompare(b.path));
  const truncated = matchCount > limit;
  const suffix = truncated ? `\n\n(已截断，仅显示前 ${limit} 个文件。请收窄 pattern 范围以获取更多。)` : "";
  const body = withDetail
    ? matched.map((e) => JSON.stringify({ path: e.path, size: e.size, mtime: e.mtime })).join("\n")
    : matched.map((e) => e.path).join("\n");
  return body + suffix;
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
  const snapshotDirectory = await fs.mkdtemp(path.join(tmpdir(), "deepseeker-run-"));
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
        let counts = stats.get(filePath) ?? { additions: 0, deletions: 0 };
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

function managedCommandResult(snapshot: CommandSnapshot, mutatedWorkspace: boolean): ToolResult {
  return {
    command: snapshot.command,
    commandActivityId: snapshot.activityId,
    commandId: snapshot.commandId,
    commandRunId: snapshot.runId,
    commandSessionId: snapshot.sessionId,
    commandState: snapshot.state,
    elapsedMs: snapshot.elapsedMs,
    exitCode: snapshot.exitCode,
    mutatedWorkspace,
    output: snapshot.state === "running" ? snapshot.outputDelta : snapshot.output,
    outputTruncated: snapshot.outputTruncated
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web 工具:fetch_url + web_search
//
// 设计要点:
//   - fetch_url:用 Node 内置 fetch 抓取 HTML,用轻量 regex 转 Markdown 风格文本。
//     不引入 turndown 等外部依赖,保持项目自包含。
//   - web_search:支持可配置的搜索后端(SEARCH_API_URL + SEARCH_API_KEY 环境变量),
//     无 key 时返回可操作的错误引导用户配置。
//   - 两者均走 redactSensitiveText 脱敏,防止抓取到的页面里含有敏感信息泄漏。
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_URL_TIMEOUT_MS = 30_000;
const FETCH_URL_MAX_BYTES = 1_000_000;

/**
 * 将 HTML 转为可读的 Markdown 风格纯文本。
 */
function htmlToReadableText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

async function fetchUrl(
  input: { url: string; maxChars?: number; format?: "markdown" | "text" },
  signal?: AbortSignal
): Promise<string> {
  const url = String(input.url ?? "").trim();
  if (!url) throw new Error("url 不能为空。");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL:${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 http 和 https 协议(收到 ${parsed.protocol})。`);
  }
  const maxChars = Math.min(Math.max(1000, input.maxChars ?? 20_000), 200_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "DeepSeeker-CodeAgent/1.0", Accept: "text/html,application/json,text/plain,*/*" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`抓取失败:HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "";
    let raw = await response.text();
    if (raw.length > FETCH_URL_MAX_BYTES) raw = raw.slice(0, FETCH_URL_MAX_BYTES);
    const format = input.format ?? "markdown";
    let body: string;
    if (contentType.includes("application/json")) {
      body = raw;
    } else if (contentType.includes("text/plain")) {
      body = raw;
    } else {
      body = format === "text" ? htmlToReadableText(raw).replace(/[*#`>\[\]()_-]/g, "") : htmlToReadableText(raw);
    }
    body = redactSensitiveText(body);
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n\n[已截断:原文 ${body.length} 字符,保留 ${maxChars} 字符]`;
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`抓取超时(${FETCH_URL_TIMEOUT_MS / 1000}s):${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function webSearch(
  input: { query: string; limit?: number; allowedDomains?: string[]; blockedDomains?: string[] },
  signal?: AbortSignal
): Promise<string> {
  const query = String(input.query ?? "").trim();
  if (!query) throw new Error("query 不能为空。");
  const apiUrl = process.env.SEARCH_API_URL;
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("未配置搜索后端。请在环境变量中设置 SEARCH_API_URL 和 SEARCH_API_KEY(支持 Brave/Bing/SerpAPI 兼容端点)。");
  }
  const limit = Math.min(Math.max(1, input.limit ?? 5), 20);
  const allowedDomains = input.allowedDomains ?? [];
  const blockedDomains = input.blockedDomains ?? [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const separator = apiUrl.includes("?") ? "&" : "?";
    const searchUrl = `${apiUrl}${separator}q=${encodeURIComponent(query)}&count=${limit}`;
    const response = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`搜索 API 返回 HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    const rawResults: unknown[] =
      Array.isArray(data.results) ? data.results
      : Array.isArray((data.web as { results?: unknown[] })?.results) ? (data.web as { results: unknown[] }).results
      : Array.isArray(data.organic) ? data.organic
      : [];
    let results: SearchResult[] = rawResults
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).url === "string")
      .map((item) => ({
        snippet: String(item.snippet ?? item.description ?? ""),
        title: String(item.title ?? "Untitled"),
        url: String(item.url)
      }));
    if (allowedDomains.length > 0) {
      results = results.filter((item) => allowedDomains.some((domain) => domainMatches(item.url, domain)));
    }
    results = results.filter((item) => !blockedDomains.some((domain) => domainMatches(item.url, domain)));
    results = results.slice(0, limit);
    if (results.length === 0) return `未找到匹配 "${query}" 的结果。`;
    const lines = results.map((item, index) =>
      `${index + 1}. ${item.title}\n   ${item.url}\n   ${redactSensitiveText(item.snippet)}`
    );
    return lines.join("\n\n");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`搜索超时(${FETCH_URL_TIMEOUT_MS / 1000}s)`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function domainMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname;
    const cleanDomain = domain.replace(/^\*\./, "").toLowerCase();
    return host === cleanDomain || host.endsWith(`.${cleanDomain}`);
  } catch {
    return false;
  }
}

export async function executeTool(input: {
  activityId?: string;
  projectRoot: string;
  name: string;
  args: Record<string, unknown>;
  onCommandSettled?: (result: ToolResult) => void;
  signal?: AbortSignal;
  onOutput?: (progress: ToolProgress) => void;
  commandCheckpointMs?: number;
  runId?: string;
  sessionId?: string;
}): Promise<ToolResult> {
  const { projectRoot, name, args, signal, onOutput, commandCheckpointMs } = input;
  if (name === "list_files") return { mutatedWorkspace: false, output: await listFiles(projectRoot, args) };
  if (name === "read_file") return { mutatedWorkspace: false, output: await readFile(projectRoot, args as never) };
  if (name === "grep") return { mutatedWorkspace: false, output: await grepFiles(projectRoot, args as never, signal) };
  if (name === "glob") return { mutatedWorkspace: false, output: await globFiles(projectRoot, args as never, signal) };
  if (name === "git_status") {
    const result = await runShell(projectRoot, "git status --short && git diff --stat", signal);
    return { ...result, mutatedWorkspace: false };
  }
  if (name === "search_capabilities") {
    const matches = searchCapabilities(projectRoot, String(args.query ?? ""), Number(args.limit ?? 10));
    return { mutatedWorkspace: false, output: JSON.stringify({ capabilities: matches }) };
  }
  if (name === "invoke_capability") {
    const loaded = await invokeCapability(
      projectRoot,
      String(args.capabilityId ?? ""),
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {},
      signal
    );
    return {
      contextUpdate: loaded.contextUpdate ? {
        metadata: {
          capabilityId: loaded.capability.capabilityId,
          label: loaded.capability.name,
          revisionHash: loaded.capability.revisionHash,
          sourceFile: loaded.capability.source,
          updateKind: loaded.capability.kind === "skill" ? "skill" : "capability"
        },
        text: loaded.contextUpdate
      } : undefined,
      mutatedWorkspace: false,
      output: loaded.output ?? JSON.stringify({ activated: Boolean(loaded.contextUpdate), capability: loaded.capability })
    };
  }
  if (name === "write_file") return { mutatedWorkspace: true, output: await writeFile(projectRoot, args as never) };
  if (name === "edit_file") return { mutatedWorkspace: true, output: await editFile(projectRoot, args as never) };
  if (name === "multi_edit") return { mutatedWorkspace: true, output: await multiEdit(projectRoot, args as never) };
  if (name === "delete_file") return { mutatedWorkspace: true, output: await deleteFile(projectRoot, args as never) };
  if (name === "fetch_url") return { mutatedWorkspace: false, output: await fetchUrl(args as never, signal) };
  if (name === "web_search") return { mutatedWorkspace: false, output: await webSearch(args as never, signal) };
  if (name === "run_command") {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("command 不能为空。");
    if (!input.activityId || !input.runId || !input.sessionId) {
      throw new Error("run_command 缺少 Runtime 生命周期标识。");
    }
    const mutatedWorkspace = !analyzeCommand(command).readOnly;
    const snapshot = await commandManager.start({
      activityId: input.activityId,
      command,
      onOutput: (text) => onOutput?.({ text }),
      onSettled: (settled) => input.onCommandSettled?.(managedCommandResult(settled, mutatedWorkspace)),
      projectRoot,
      runId: input.runId,
      sessionId: input.sessionId,
      signal
    }, commandCheckpointMs);
    return managedCommandResult(snapshot, mutatedWorkspace);
  }
  if (name === "wait_command") {
    const commandId = String(args.commandId ?? "").trim();
    if (!commandId) throw new Error("commandId 不能为空。");
    const existing = commandManager.get(commandId);
    if (!existing) throw new Error(`未找到命令：${commandId}`);
    return managedCommandResult(
      await commandManager.wait(commandId, commandCheckpointMs, signal),
      !analyzeCommand(existing.command).readOnly
    );
  }
  if (name === "stop_command") {
    const commandId = String(args.commandId ?? "").trim();
    if (!commandId) throw new Error("commandId 不能为空。");
    const existing = commandManager.get(commandId);
    if (!existing) throw new Error(`未找到命令：${commandId}`);
    const stopped = await commandManager.stop(commandId);
    if (!stopped) throw new Error(`未找到命令：${commandId}`);
    return managedCommandResult(stopped, !analyzeCommand(existing.command).readOnly);
  }
  throw new Error(`未知工具：${name}`);
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
  type: "object"
});

// ─────────────────────────────────────────────────────────────────────────────
// 工具注册表。
//
// 描述编写规范(对标 Anthropic 官方工具描述指南 + Claude Code / Codex 最佳实践):
//   1. 每个描述至少说明用途、适用时机、不适用场景和注意事项
//   2. 使用“适用场景”与“不适用场景”双向引导，防止工具误选
//   3. 关键工具附 Example(对标 Codex apply_patch / Claude Code Bash)
//   4. 硬性规则用 IMPORTANT / MUST / NEVER 强调
//   5. inputSchema 每个字段带 description(传给模型的 JSON Schema)
//   6. 模型可见说明统一使用中文；工具名、字段名和枚举值保持协议原文
// ─────────────────────────────────────────────────────────────────────────────

const toolRegistry: ToolRegistration[] = [
  {
    // 搜索项目 Skill / MCP / 长尾能力(渐进式披露)
    name: "search_capabilities",
    description: "搜索未预加载进系统提示词的项目 Skill、MCP 工具或其他长尾能力。返回简短元数据；需要完整内容时，再使用 invoke_capability 加载。\n\n适用场景：需要可能以 Skill 提供的专业工作流，例如 PDF 处理、Android 开发或 iOS 开发；不确定项目中存在哪些能力。\n\n不适用场景：已经知道 capabilityId，应直接使用 invoke_capability；需要搜索项目源码，应使用 grep、glob 或 read_file。\n\n示例：\n  search_capabilities(query=\"pdf\")\n  search_capabilities(query=\"android emulator\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "搜索词，用关键词描述所需能力，例如“pdf”“android”“代码审查”" },
      limit: { type: "number", description: "最多返回多少项结果，默认 10" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "capability index")
    }
  },
  {
    // 按 capabilityId 启用长尾能力
    name: "invoke_capability",
    description: "根据 capabilityId 启用已经发现的长尾能力。对于 Skill，完整 SKILL.md 会作为独立 ContextUpdate 注入，必须读取并遵循。\n\n适用场景：已经通过 search_capabilities 找到相关能力，需要其完整指令或工具访问权限。\n\n不适用场景：尚未搜索，应先调用 search_capabilities；该能力已经加载到当前上下文。\n\n示例：\n  invoke_capability(capabilityId=\"skill:pdf\")\n  invoke_capability(capabilityId=\"mcp:github\", arguments={owner: \"octocat\", repo: \"Hello-World\"})",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "search_capabilities 返回的能力标识符，例如 'skill:pdf' 或 'mcp:github'" },
      arguments: { type: "object", additionalProperties: true, description: "可选，传递给该能力的参数" }
    }, ["capabilityId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.capabilityId ?? "capability")
    }
  },
  {
    // 按关键词读取已确认的结构化记忆事实
    name: "search_memory",
    description: "按关键词读取用户确认过的结构化 MemoryFact。这些是用户或先前会话保存并经过整理的事实，例如“项目使用 pnpm”“测试使用 vitest”。本工具只读，不会自动创建记忆。\n\n适用场景：任务开始时检查用户或项目是否保存过偏好和约定；向用户提问前，确认对方是否已经提供过答案。\n\n不适用场景：需要当前代码库状态，应使用 read_file 或 grep；需要保存新事实，目前尚无保存工具，应向用户说明。\n\n示例：\n  search_memory(query=\"package manager\")\n  search_memory(query=\"test framework\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "用于搜索已保存记忆事实的关键词或短语" },
      limit: { type: "number", description: "最多返回多少条事实，默认 10" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "memory")
    }
  },
  {
    // 列出项目文件树
    name: "list_files",
    description: "以树形结构列出项目文件，自动跳过依赖目录（node_modules、dist、.git、.venv）、构建产物和敏感文件。\n\n适用场景：任务开始时需要项目结构的整体概览；深入具体文件前需要理解目录布局。\n\n不适用场景：需要匹配特定模式的文件，应使用 glob；需要搜索文件内容，应使用 grep；项目很大且只需要其中一部分。\n\n注意：结果受 maxFiles 限制，默认 200。大型项目应优先使用带具体模式的 glob。\n\n示例：\n  list_files()\n  list_files(maxFiles=500)",
    inputSchema: objectSchema({
      maxFiles: { type: "number", description: "最多返回多少个文件条目，默认 200，并受硬性上限约束" }
    }),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "directory",
      resolveTarget: (_args, projectRoot) => workspaceRelativeTarget(projectRoot, ".")
    }
  },
  {
    // 读取文件内容
    name: "read_file",
    description: "读取项目根目录内的 UTF-8 文本文件并返回内容。大文件超过 maxChars 时会截断并给出提示。\n\n适用场景：需要检查或修改文件内容；即将编辑文件，必须先读取；可以在同一条消息中批量读取多个可能有用的文件，以便并行加载。\n\n不适用场景：只需要了解有哪些文件，应使用 glob 或 list_files；需要跨多个文件搜索模式，应使用 grep；目标是图片或二进制文件，本工具不支持。\n\n重要：使用 edit_file 或 write_file 编辑文件前，必须先读取并理解其当前内容。未读取就编辑容易导致 oldText 匹配错误。\n\n示例：\n  read_file(path=\"src/App.tsx\")\n  read_file(path=\"package.json\")\n  # 在一条消息中批量并行读取：\n  #   read_file(path=\"src/App.tsx\"), read_file(path=\"src/main.tsx\"), read_file(path=\"vite.config.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "文件相对于工作区的路径，例如 'src/App.tsx' 或 'package.json'" },
      maxChars: { type: "number", description: "截断前最多读取的字符数，默认 200000。只需要大文件开头时应调小此值。" }
    }, ["path"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 内容搜索(结构化扫描,跨平台稳定)
    name: "grep",
    description: "在整个项目中进行快速、结构化且跨平台稳定的内容搜索，在 Windows、Linux 和 macOS 上行为一致。使用 JavaScript 正则搜索文件内容；危险正则会被拒绝，超过 2 MiB 的文件和二进制文件会被跳过。\n\n适用场景：搜索代码、字符串或标记时始终优先使用 grep，例如 TODO 注释、函数名、调用点和错误日志。本工具是主要的内容搜索入口。\n\n不适用场景：需要按名称或扩展名查找文件，应使用 glob；需要项目整体概览，应使用 list_files；需要执行 shell 命令，应使用 run_command。\n\n重要：绝不能通过 run_command 执行 rg、grep、findstr 或 find。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过本工具的依赖过滤和敏感文件保护。\n\n功能：\n- pattern：完整 JavaScript 正则，例如 'log.*Error'、'function\\\\s+\\\\w+'\n- output_mode：'files_with_matches' 默认只返回工作区相对路径，节省 token，建议首次搜索使用；也支持 'content'、'count'、'json'\n- 使用 glob 过滤文件类型，使用 path 限定子目录，使用 context 返回 0 至 3 行上下文\n- 搜索包含正则元字符的字面量，例如 URL 或 API Key 时，设置 fixed_strings=true\n- 自动跳过 node_modules、dist、.git，自动排除 .env、*.key、id_rsa，并对输出脱敏\n\n示例：\n  grep(pattern=\"TODO\", glob=\"**/*.ts\", output_mode=\"content\", context=2)\n  grep(pattern=\"api.deepseek.com\", fixed_strings=true)",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "要搜索的 JavaScript（ECMAScript）正则。不要使用 (?i) 等 PCRE 内联标志，改用 case_sensitive=false。" },
      path: { type: "string", description: "可选，用工作区相对路径限定搜索子目录，例如 'src/'" },
      glob: { type: "string", description: "可选，用 minimatch 模式过滤文件类型，例如 '**/*.ts' 或 '**/*.{tsx,ts}'" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count", "json"], description: "结果格式：'files_with_matches' 默认只返回路径；'content' 返回 path:line:content；'count' 返回每个文件的命中数；'json' 返回结构化字段" },
      case_sensitive: { type: "boolean", description: "是否区分大小写，默认 true。需要忽略大小写时设为 false，不要写 (?i)。" },
      fixed_strings: { type: "boolean", description: "是否把 pattern 视为字面量并转义正则元字符，默认 false。搜索 URL、API Key 或含特殊字符的字符串时使用。" },
      context: { type: "number", description: "每个匹配项前后显示多少行上下文，范围 0 至 3，默认 0" },
      max_results: { type: "number", description: "最多返回多少个匹配项，默认 200" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "search")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "search")
    }
  },
  {
    // 文件路径匹配(minimatch,跨平台稳定)
    name: "glob",
    description: "使用 minimatch 模式快速匹配文件路径，跨平台行为稳定，在 Windows、Linux 和 macOS 上保持一致。返回工作区相对路径，并按修改时间从新到旧排序。\n\n适用场景：按名称、扩展名或路径模式查找文件时始终优先使用 glob，例如查找所有 .tsx 组件、测试文件或配置文件。本工具是主要的文件发现入口。\n\n不适用场景：需要搜索文件内容，应使用 grep；需要项目整体概览，应使用 list_files；需要执行 shell 命令，应使用 run_command。\n\n重要：绝不能通过 run_command 执行 find、ls、Get-ChildItem、dir 或 where。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过本工具的依赖过滤。\n\n模式语法：** 跨目录，* 匹配单个路径段，{a,b} 表示枚举，? 匹配单个字符。\n\n示例：\n  glob(pattern=\"src/components/**/*.tsx\")\n  glob(pattern=\"**/*.test.ts\")\n  glob(pattern=\"*.{json,md,yaml}\")\n\nglob 与 grep 共同组成标准的“查找文件 → 读取内容”流程。",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "Minimatch glob 模式，例如 'src/**/*.tsx'、'**/*.test.ts' 或 '*.{json,md}'" },
      path: { type: "string", description: "可选，用工作区相对路径限定搜索子目录" },
      detail: { type: "boolean", description: "设为 true 时，在每个结果后附加文件大小和修改时间，默认 false" },
      limit: { type: "number", description: "最多返回多少条路径，默认 200" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "directory",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "match")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "match")
    }
  },
  {
    // 读取 Git 工作区状态
    name: "git_status",
    description: "读取当前 Git 工作树状态和 diff 摘要，返回已暂存、未暂存、未跟踪文件列表以及精简 diff。\n\n适用场景：提交前确认有哪些改动；编辑后验证真实 diff 是否符合预期；用户询问“改了什么”。\n\n不适用场景：需要执行 commit、push、log 等任意 Git 命令，应使用 run_command；只需要读取特定文件，应使用 read_file。\n\n示例：\n  git_status()",
    inputSchema: objectSchema({}),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: () => "Git working tree"
    }
  },
  {
    // 联网搜索
    name: "web_search",
    description: "联网搜索最新信息，例如新 SDK、错误消息、API 规范和库文档。返回包含标题、URL 和摘要的结果列表。\n\n适用场景：模型知识可能已经过时，例如新版本库、近期 API 变更、陌生错误消息或特定版本行为；用户询问近期信息。\n\n不适用场景：答案可以从本地代码库找到，应使用 grep、glob 或 read_file；信息稳定且已有知识足够；需要完整网页内容，应对具体 URL 使用 fetch_url。\n\n重要：联网搜索需要配置搜索后端，即 SEARCH_API_URL 和 SEARCH_API_KEY 环境变量。未配置时，错误信息会引导用户完成设置。结果会经过密钥脱敏。\n\n标准流程：先用 web_search 找到相关页面，再用 fetch_url 阅读最佳结果的完整内容。\n\n示例：\n  web_search(query=\"DeepSeek V4 function calling spec\", limit=5)\n  web_search(query=\"npm ERR! ERESOLVE peer dependency\", allowedDomains=[\"stackoverflow.com\", \"docs.npmjs.com\"])",
    inputSchema: objectSchema({
      query: { type: "string", description: "搜索词" },
      limit: { type: "number", description: "最多返回多少项结果，默认 5，最大 20" },
      allowedDomains: { type: "array", items: { type: "string" }, description: "可选，只允许这些域名的结果，例如 ['docs.python.org', 'stackoverflow.com']" },
      blockedDomains: { type: "array", items: { type: "string" }, description: "可选，排除这些域名的结果" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "web search")
    }
  },
  {
    // 抓取网页内容
    name: "fetch_url",
    description: "抓取指定 URL，并以 Markdown 返回内容；HTML 会转换，JSON 和纯文本会原样传递。大型页面超过 maxChars 时会截断。\n\n适用场景：web_search 找到相关页面后，需要阅读全文；需要读取 API 文档、Stack Overflow 回答或博客文章。\n\n不适用场景：还没有具体 URL，应先使用 web_search；内容位于本地项目，应使用 read_file。\n\n功能：\n- 将 HTML 转为 Markdown，保留标题、链接、列表、代码块和引用\n- 移除 script、style、nav、footer 等噪声\n- 按 maxChars 截断，默认 20000、最大 200000，并给出截断提示\n- 仅支持 http 和 https URL\n- 30 秒超时\n- 输出经过密钥脱敏\n\n示例：\n  fetch_url(url=\"https://docs.example.com/api/v2\", format=\"markdown\", maxChars=20000)",
    inputSchema: objectSchema({
      url: { type: "string", description: "要抓取的 http 或 https URL" },
      maxChars: { type: "number", description: "截断前最多返回的字符数，默认 20000，最大 200000" },
      format: { type: "string", enum: ["markdown", "text"], description: "输出格式：'markdown' 默认保留结构；'text' 移除 Markdown 语法" }
    }, ["url"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.url ?? "URL")
    }
  },
  {
    // 创建/覆盖文件
    name: "write_file",
    description: "使用给定的完整内容创建新文件，或覆盖现有文件。\n\n适用场景：创建尚不存在的新文件；完整替换某个文件，例如重写配置；文件足够小，可以完整输出。\n\n不适用场景：只修改现有文件的一部分，应使用更节省且更安全的 edit_file；文件已经存在但尚未读取。\n\n重要：如果文件已经存在，必须先使用 read_file 读取。未读取就覆盖可能丢失未知的重要内容。局部改动应优先使用 edit_file，它能产生更小、更易审查的 diff。\n\n示例：\n  write_file(path=\"src/utils/helpers.ts\", content=\"export const add = (a: number, b: number) => a + b;\\n\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要创建或覆盖的工作区相对路径，例如 'src/utils/helpers.ts'" },
      content: { type: "string", description: "要写入的完整文件内容" }
    }, ["path", "content"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 精确文本替换编辑
    name: "edit_file",
    description: "通过把 oldText 精确替换为 newText 来编辑现有文件。\n\n适用场景：修改现有文件的特定部分。本工具是局部编辑的首选，能产生最小且易审查的 diff。\n\n不适用场景：创建新文件，应使用 write_file；目标文件尚不存在。\n\n重要：如果 oldText 在文件中不唯一，编辑会失败。若出现多次，应提供更多周边上下文使其唯一，或设置 replaceAll=true 替换全部匹配项。\n\n示例：\n  edit_file(path=\"src/App.tsx\", oldText=\"const foo = 1;\", newText=\"const foo = 2;\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要编辑文件的工作区相对路径" },
      oldText: { type: "string", description: "要查找的精确文本。除非 replaceAll 为 true，否则必须在文件中唯一。请包含足够的周边上下文以确保唯一性。" },
      newText: { type: "string", description: "替换后的文本" },
      replaceAll: { type: "boolean", description: "设为 true 时替换 oldText 的所有匹配项，默认 false" }
    }, ["path", "oldText", "newText"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 批量原子编辑(多个 oldText→newText,单次写盘)
    name: "multi_edit",
    description: "在一次原子操作中，对同一个文件执行多项精确文本替换。所有编辑先应用于内存内容，只有全部成功后才写盘一次。\n\n适用场景：重构单个文件且需要三个或更多相互协调的编辑，例如重命名符号、更新导入并修正调用点。相比连续多次调用 edit_file，本工具更快，并产生一个整洁的 diff。\n\n不适用场景：只有一项改动，应使用 edit_file；创建新文件，应使用 write_file。\n\n原子性保证：只要任一 oldText 匹配失败，例如不存在或未使用 replaceAll 时存在歧义，整个批次都会回滚，不会向磁盘写入任何改动。错误结果会列出所有失败编辑的索引和原因。\n\n重要：每项编辑的 oldText 必须在原始文件内容中唯一，除非该项设置 replaceAll=true。编辑会依次应用到同一内容缓冲区，因此前面的替换对后面的编辑可见，排序时必须考虑这一点。\n\n示例：\n  multi_edit(path=\"src/App.tsx\", edits=[\n    {oldText: \"const foo = 1;\", newText: \"const foo = 2;\"},\n    {oldText: \"return null;\", newText: \"return <App/>;\"},\n    {oldText: \"import React\", newText: \"import React, { useState }\"}\n  ])",
    inputSchema: objectSchema({
      path: { type: "string", description: "要编辑文件的工作区相对路径" },
      edits: {
        type: "array",
        minItems: 1,
        description: "要原子应用的编辑数组。所有编辑必须全部成功，否则一项也不会写入。",
        items: objectSchema({
          oldText: { type: "string", description: "要查找的精确文本。除非 replaceAll 为 true，否则必须在文件中唯一。" },
          newText: { type: "string", description: "替换后的文本" },
          replaceAll: { type: "boolean", description: "设为 true 时替换 oldText 的所有匹配项，默认 false" }
        }, ["oldText", "newText"])
      }
    }, ["path", "edits"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 删除文件(危险操作)
    name: "delete_file",
    description: "删除项目根目录内的单个文件。这是具有破坏性且不可逆的操作，需要用户审批。\n\n适用场景：用户明确要求删除文件；重构过程中需要移除生成文件。\n\n不适用场景：只想清空文件内容但保留文件，应使用空内容调用 write_file 或使用 edit_file；用户没有要求删除。\n\n重要：删除需要用户审批，并且在 Git 之外无法撤销。调用前必须确认路径正确。\n\n示例：\n  delete_file(path=\"src/legacy/old-module.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要删除文件的工作区相对路径" }
    }, ["path"]),
    presentation: {
      groupMode: "standalone",
      detail: { ...COLLAPSED_FILE_DETAIL, defaultCollapsed: false },
      effect: "workspace_write",
      importance: "critical",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 执行 shell 命令(托管对象)
    name: "run_command",
    description: "在项目根目录执行 shell 命令，例如构建、测试、Git 操作和启动进程。这是一个受托管对象：命令会在前台等待 60 秒；如果仍在运行，将返回 commandId，此时必须使用 wait_command 继续等待，或使用 stop_command 停止。\n\n适用场景：仅用于真实 shell 执行，包括构建（npm run build）、测试（npm test）、Git 操作（git commit）、启动开发服务器和运行脚本。\n\n不适用场景：搜索代码或文件，应分别使用 grep、glob、list_files 或 read_file。\n\n重要：绝不能通过 run_command 执行 rg、grep、findstr、find、cat、head、tail 或 ls。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过专用工具的依赖过滤和敏感文件保护。\n\n托管命令规则：\n- 命令运行超过 60 秒时会返回 commandId。使用 wait_command 继续等待，或使用 stop_command 终止。\n- 不要重复运行同一个长命令来轮询，这会创建重复进程。应对现有 commandId 使用 wait_command。\n- 仍有托管命令运行时，Run 不能结束。结束前必须调用 wait_command 或 stop_command。\n\n非安全命令，包括修改和网络访问，需要用户审批。对于非简单或潜在高风险命令，例如删除、强制推送或安装，请在调用前用 content 简短说明命令的作用和原因，帮助用户在审批前理解操作。\n\n示例：\n  run_command(command=\"npm run build\")\n  run_command(command=\"npm test\")\n  run_command(command=\"git add -A && git commit -m 'feat: add login page'\")",
    inputSchema: objectSchema({
      command: { type: "string", description: "要执行的 shell 命令，例如 'npm run build'、'git status' 或 'npx tsc --noEmit'" }
    }, ["command"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "execute",
      targetKind: "process",
      resolveSemantics: (args) => classifyCommand(String(args.command ?? "")),
      resolveTarget: (args) => String(args.command ?? "")
    }
  },
  {
    // 等待托管命令
    name: "wait_command",
    description: "等待仍在运行的托管命令。返回自上次轮询以来的 stdout、stderr 增量输出，并最多阻塞 60 秒；命令退出时会提前返回。\n\n适用场景：run_command 因命令运行超过 60 秒而返回 commandId；需要收集更多输出或确认命令是否完成。\n\n不适用场景：命令已经退出，结果已经直接返回；希望停止命令而不是等待，应使用 stop_command。\n\n重要：不要重新运行原命令来轮询，这会创建重复的托管对象。始终对现有 commandId 使用 wait_command。\n\n示例：\n  wait_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "run_command 在命令仍运行时返回的 commandId" }
    }, ["commandId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "routine",
      action: "execute",
      targetKind: "process",
      resolveTarget: (args) => String(args.commandId ?? "")
    }
  },
  {
    // 停止托管命令
    name: "stop_command",
    description: "停止托管命令及其完整进程树。对已经停止或退出的命令调用也是安全的，操作具有幂等性。\n\n适用场景：不再需要某个长时间运行的命令，例如开发服务器，需要终止它；Run 因命令仍在运行而无法结束，并且不希望继续等待。\n\n不适用场景：希望继续等待命令，应使用 wait_command。\n\n示例：\n  stop_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "要停止的托管命令 commandId" }
    }, ["commandId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "execute",
      targetKind: "process",
      resolveTarget: (args) => String(args.commandId ?? "")
    }
  },
  {
    // 请求进入计划模式
    name: "enter_plan",
    description: "在产生任何副作用前，请求进入计划模式。计划模式只允许只读操作，包括读取、搜索、提问和形成方案，不得修改工作区或产生外部副作用。\n\n适用场景：任务复杂、跨模块、涉及重大权衡或迁移、存在安全风险、难以回滚；用户明确要求先制定计划。\n\n不适用场景：任务简单且明确，应直接完成；已经开始修改文件，计划模式只适用于实施前阶段。\n\n重要：这是独立控制工具，Run 可能暂停直至用户确认。\n\n示例：\n  enter_plan(reason=\"该重构跨越 3 个模块和 12 个文件，并存在迁移风险\")",
    inputSchema: objectSchema({
      reason: { type: "string", description: "说明本任务为何需要计划模式，例如“该重构跨越 3 个模块和 12 个文件，并存在迁移风险”" }
    }, ["reason"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "plan mode"
    }
  },
  {
    // 在计划模式中向用户提问
    name: "ask_user",
    description: "向用户提出一至三个会实质影响计划的简短问题，然后等待回答。每个问题可以提供两至三个选项，也可以开放回答。\n\n适用场景：在计划模式中已经收集足够上下文，可以形成方案，但完成计划前仍需要用户做关键决策，例如“使用 A 还是 B 库”“现在迁移还是保留向后兼容”。\n\n不适用场景：信息已经足够提交计划，应使用 submit_plan；当前处于工作模式，ask_user 仅限计划模式；问题琐碎且不会改变计划。\n\n重要：这是独立控制工具。只询问答案会改变计划的问题；能通过工具自行查明的信息不要询问用户。\n\n示例：\n  ask_user(questions=[\n    {questionId: \"q1\", label: \"状态库\", prompt: \"应使用哪个状态管理库？\", options: [\"Zustand\", \"Redux\", \"Jotai\"]},\n    {questionId: \"q2\", label: \"迁移\", prompt: \"现在迁移，还是暂时保留向后兼容？\"}\n  ])",
    inputSchema: objectSchema({
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: objectSchema({
          questionId: { type: "string", description: "问题的唯一标识符，用于映射答案" },
          label: { type: "string", description: "以标签或标题形式展示的简短名称，最多 12 个字符" },
          prompt: { type: "string", description: "完整问题文本" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3, description: "二至三个预设选项。开放式问题应省略此字段。" }
        }, ["questionId", "label", "prompt"]),
        description: "向用户提出的一至三个问题，每个问题都必须对计划产生实质影响。"
      }
    }, ["questions"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "plan questions"
    }
  },
  {
    // 提交实施方案
    name: "submit_plan",
    description: "以 Markdown 提交一份可直接决策的完整实施计划供用户审阅。提交后 Run 会暂停并等待用户决定，绝不能自行开始实施。\n\n适用场景：在计划模式中，方案已经可直接决策，所有关键选择均已确定且没有待确认问题；ask_user 轮次已经结束，可以提交审批。\n\n不适用场景：仍有待确认问题，应先使用 ask_user；当前处于工作模式，应直接执行；任务足够简单，不需要计划。\n\n重要：这是独立控制工具。计划必须是完整、可执行的 Markdown 文档，不能只是模糊提纲；应包含改动内容、原因、文件级步骤、风险和验证命令。\n\n示例：\n  submit_plan(title=\"增加 JWT 身份认证\", markdown=\"## 目标\\n使用 JWT 保护 API...\\n## 步骤\\n1. 安装 jsonwebtoken\\n2. 创建认证中间件\\n3. 增加登录路由\\n## 验证\\n- npm test\\n- curl localhost:3000/login\")",
    inputSchema: objectSchema({
      title: { type: "string", description: "计划的简短标题，例如“使用 JWT 增加用户认证”" },
      markdown: { type: "string", description: "完整的 Markdown 计划正文，应包含目标、方案、文件级步骤、风险和验证方式" }
    }, ["title", "markdown"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "implementation plan"
    }
  },
  {
    // 执行期任务清单(对标 Claude Code TodoWrite / Codex update_plan)
    name: "update_tasks",
    description: "创建或替换当前 Run 的执行任务列表。这是整体任务清单、当前任务以及 pending、running、completed、blocked 状态的唯一维护渠道。调用本工具后，界面会将任务进度直接呈现给用户；不要在调用工具时的回答内容中再次汇报任务计划进度，也不要重复播报任务完成、当前任务、下一任务、阶段切换或执行批次。\n\n适用场景：任务包含三个或更多跨文件、跨阶段的独立步骤，例如“在代码库中重命名符号”可拆为读取用法、修改导入、修改调用点和运行类型检查；希望在工作过程中向用户展示进度；复杂缺陷修复包含多个调查步骤。\n\n不适用场景：简单问答或单文件编辑，应直接完成；只有一至两个步骤；当前处于计划模式，应使用 submit_plan。\n\n重要：这是独立控制工具。复杂任务开始时调用 update_tasks 列出步骤，状态变化时提交包含全部步骤的完整列表。任何时刻必须只保留一个 'running' 任务；已经完成的步骤保留为 'completed'，受阻步骤标记为 'blocked'。如果已经建立任务清单，所有工作和验证结束后，必须在最后一个工作工具调用之后再次调用本工具，提交不含 pending 或 running 的最终完整列表。最终维护必须是独立的 assistant step，同一响应不要输出面向用户的最终回答；收到工具结果后的下一轮再给出最终回答。本工具不用于计划审批。\n\n示例，为“增加深色模式”建立高质量任务列表：\n  update_tasks(tasks=[\n    {taskId:'t1', label:'读取现有主题系统', status:'running'},\n    {taskId:'t2', label:'增加深色调色板 CSS 变量', status:'pending'},\n    {taskId:'t3', label:'在设置中接入主题开关', status:'pending'},\n    {taskId:'t4', label:'通过构建和手动检查验证', status:'pending'}\n  ])",
    inputSchema: objectSchema(
      {
        tasks: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              label: { type: "string", description: "用户可读的任务步骤说明" },
              status: { type: "string", enum: ["pending", "running", "completed", "blocked"], description: "当前状态：'pending' 尚未开始，'running' 正在进行且必须只保留一个，'completed' 已完成，'blocked' 受阻" },
              taskId: { type: "string", description: "任务的唯一标识符" }
            },
            ["taskId", "label", "status"]
          ),
          description: "完整任务列表，会替换先前列表。必须包含全部步骤，而不只是发生变化的步骤。"
        }
      },
      ["tasks"]
    ),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "routine",
      action: "task",
      targetKind: "task",
      resolveTarget: () => "execution tasks"
    }
  },
  {
    // 子 Agent 任务委派(对标 Claude Code Task / Codex sub-agent)
    name: "spawn_agent",
    description: "启动一个新 Agent 处理复杂的多步骤任务。子 Agent 在隔离会话中运行，只有最终摘要会进入父对话，中间步骤不会进入。\n\n适用场景：跨大量文件搜索关键词或模式，让子 Agent 探索而不污染当前上下文；探索陌生的代码库区域；可以并行进行的多方向研究，例如同时查找测试模式、路由结构和数据库 schema；中间探索会消耗过多上下文的任务。\n\n不适用场景：读取一个已知文件，应使用 read_file；简单的单模式搜索，应使用 grep；一至两次工具调用即可解决的任务；需要让用户看到每个步骤，子 Agent 的中间步骤不会展示。\n\n子 Agent 类型：\n- 'Explore'：只读，可使用 read_file、grep、glob、list_files、git_status、search_memory，适合调查和研究\n- 'general-purpose'：除 spawn_agent 外可使用完整工具集，适合需要编辑文件或执行命令的任务\n\n返回值：只返回子 Agent 的最终文本摘要，中间工具调用和 reasoning 不会进入父对话。\n\n并行性：在同一条消息中发起多个 spawn_agent 会并发运行，适合彼此独立的研究任务。\n\n重要：子 Agent 不能继续创建子 Agent，不允许递归。子 Agent 从全新上下文开始，因此 prompt 必须自包含，提供完成任务所需的全部上下文。\n\n示例：\n  spawn_agent(description='查找未捕获的 Promise 拒绝', prompt='扫描 src/ 下所有 .ts 文件，查找没有 .catch() 的 .then() 调用链，并报告每个问题的 file:line。', subagentType='Explore')",
    inputSchema: objectSchema({
      description: { type: "string", description: "用于日志和活动时间线的简短任务说明" },
      prompt: { type: "string", description: "给子 Agent 的完整、自包含任务提示词。必须提供全部必要上下文，子 Agent 看不到父对话。" },
      subagentType: { type: "string", enum: ["Explore", "general-purpose"], description: "'Explore' 使用只读研究工具；'general-purpose' 使用完整工具集，可以编辑文件和运行命令" }
    }, ["description", "prompt", "subagentType"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "execute",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.description ?? "子 Agent")
    }
  }
];

export const toolSpecs: ToolSpec[] = toolRegistry.map(
  ({ description, inputSchema, name }) => ({ description, inputSchema, name })
);

function registrationFor(name: string): ToolRegistration {
  const registration = toolRegistry.find((tool) => tool.name === name);
  if (!registration) throw new Error(`未知工具：${name}`);
  return registration;
}

export function hasTool(name: string): boolean {
  return toolRegistry.some((tool) => tool.name === name);
}

export function toolNames(): string[] {
  return toolRegistry.map((tool) => tool.name);
}

export function toolCanRunInParallel(name: string): boolean {
  if (name === "run_command") return true;
  if (name === "search_memory") return false;
  const registration = toolRegistry.find((tool) => tool.name === name);
  return registration?.presentation.effect === "read_only";
}

export function createToolState(input: {
  args?: Record<string, unknown>;
  argumentsPreview?: string;
  callId: string;
  modelStepId: string;
  name: string;
  projectRoot: string;
  result?: ToolResult;
  output?: string;
}): PreparedToolState {
  const registration = registrationFor(input.name);
  const args = input.args ?? {};
  const overrides = registration.presentation.resolveSemantics?.(args) ?? {};
  const presentation = { ...registration.presentation, ...overrides };
  const target = presentation.resolveTarget(args, input.projectRoot);
  return {
    groupMode: presentation.groupMode,
    argumentsPreview: input.argumentsPreview ?? "",
    callId: input.callId,
    detail: presentation.detail,
    displayTarget: target,
    effect: presentation.effect,
    importance: presentation.importance,
    modelStepId: input.modelStepId,
    normalizedTarget: target.trim().replaceAll("\\", "/"),
    action: presentation.action,
    targetKind: presentation.targetKind,
    resultMetrics: input.result && input.output
      ? resultMetricsFor(input.name, args, input.output, input.result, presentation.action)
      : undefined,
    resultSummary: input.output ? summarizeToolResult(input.name, args, input.output).slice(0, 500) : undefined,
    toolName: input.name
  };
}

function resultMetricsFor(
  name: string,
  args: Record<string, unknown>,
  output: string,
  result: ToolResult,
  action: ActionKind
): ToolMetrics {
  const lines = output.split("\n").filter(Boolean).length;
  const grepItemCount = name === "grep" ? (() => {
    const mode = String(args.output_mode ?? "files_with_matches");
    if (mode === "json") {
      try {
        const hits = JSON.parse(output) as Array<{ path?: string }>;
        return new Set(hits.map((hit) => hit.path).filter(Boolean)).size;
      } catch {
        return undefined;
      }
    }
    const paths = output.split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("(") && line !== "未找到匹配内容。")
      .map((line) => mode === "files_with_matches" ? line : line.split(":", 1)[0]);
    return new Set(paths).size;
  })() : undefined;
  return {
    byteCount: Buffer.byteLength(output),
    exitCode: result.exitCode,
    itemCount: name === "grep"
      ? grepItemCount
      : name === "list_files" || name === "glob"
        ? lines
        : name === "read_file" || action === "modify" ? 1 : undefined,
    matchCount: action === "search" ? lines : undefined,
    timedOut: result.timedOut,
    truncated: name === "read_file" && output.length >= Number(args.maxChars ?? 40_000)
  };
}

export function activityKindForTool(tool: ToolState): ActivityKind {
  if (tool.toolName === "submit_plan") return "plan";
  if (tool.action === "modify") return "file_mutation";
  if (tool.action === "execute" || tool.action === "verify") return "command";
  return "tool";
}

export function toolTitle(name: string): string {
  return ({
    invoke_capability: "启用能力",
    ask_user: "询问方案问题",
    delete_file: "删除文件",
    edit_file: "编辑文件",
    git_status: "检查 Git 状态",
    enter_plan: "进入计划模式",
    list_files: "列出项目文件",
    read_file: "读取文件",
    grep: "搜索文件内容",
    glob: "匹配文件路径",
    search_capabilities: "搜索能力",
    search_memory: "检索记忆",
    run_command: "运行命令",
    wait_command: "等待命令",
    stop_command: "停止命令",
    submit_plan: "提交实施方案",
    update_tasks: "更新执行任务",
    write_file: "写入文件",
    multi_edit: "批量编辑文件",
    fetch_url: "抓取网页",
    web_search: "联网搜索",
    spawn_agent: "启动子 Agent"
  } as Record<string, string>)[name] ?? name;
}

export const toolHost: ToolHost = {
  capture: captureBaseline,
  changes: collectChanges,
  checkpoint: checkpointTarget,
  close: releaseBaseline,
  execute: executeTool,
  has: hasTool,
  kind: activityKindForTool,
  names: toolNames,
  parallel: toolCanRunInParallel,
  prepare: createToolState,
  retain: retainBaseline,
  runningCommands: (runId) => commandManager.running(runId),
  specs: toolSpecs,
  stopCommands: (runId) => commandManager.stopRun(runId),
  summarizeArgs: summarizeToolArguments,
  summarizeResult: summarizeToolResult,
  title: toolTitle
};
