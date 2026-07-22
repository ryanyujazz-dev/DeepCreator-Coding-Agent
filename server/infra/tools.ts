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
//   1. 每个描述至少 3-4 句:what it does / when to use / when NOT to use / caveats
//   2. 使用 "When to use" / "When NOT to use" 双向引导(防止工具误选)
//   3. 关键工具附 Example(对标 Codex apply_patch / Claude Code Bash)
//   4. 硬性规则用 IMPORTANT / MUST / NEVER 强调
//   5. inputSchema 每个字段带 description(传给模型的 JSON Schema)
//   6. 全部使用英文(模型遵循度最高);中文含义在代码注释中保留
// ─────────────────────────────────────────────────────────────────────────────

const toolRegistry: ToolRegistration[] = [
  {
    // 搜索项目 Skill / MCP / 长尾能力(渐进式披露)
    name: "search_capabilities",
    description: "Search for project Skills, MCP tools, or other long-tail capabilities that are not pre-loaded into the system prompt. Returns short metadata entries; use invoke_capability to load the full body.\n\nWhen to use: You need a specialized workflow (e.g. PDF processing, Android dev, iOS dev) that may be available as a Skill. You are unsure what capabilities exist in this project.\n\nWhen NOT to use: You already know the capabilityId (use invoke_capability directly). You need project source code (use grep/glob/read_file).\n\nExample:\n  search_capabilities(query=\"pdf\")\n  search_capabilities(query=\"android emulator\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "Search query — keywords describing the capability you need (e.g. 'pdf', 'android', 'code review')" },
      limit: { type: "number", description: "Maximum number of results to return (default 10)" }
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
    description: "Activate a discovered long-tail capability by its capabilityId. For Skills, the full SKILL.md body is injected as an independent ContextUpdate that you must read and follow.\n\nWhen to use: You found a relevant capability via search_capabilities and need its full instructions or tool access.\n\nWhen NOT to use: You have not searched yet (call search_capabilities first). The capability is already loaded in the current context.\n\nExample:\n  invoke_capability(capabilityId=\"skill:pdf\")\n  invoke_capability(capabilityId=\"mcp:github\", arguments={owner: \"octocat\", repo: \"Hello-World\"})",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "The capability identifier returned by search_capabilities (e.g. 'skill:pdf', 'mcp:github')" },
      arguments: { type: "object", additionalProperties: true, description: "Optional arguments to pass to the capability" }
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
    description: "Read user-confirmed structured MemoryFacts by keyword. These are curated facts the user or a previous session saved (e.g. 'this project uses pnpm', 'tests run with vitest'). Read-only — never auto-creates memories.\n\nWhen to use: At the start of a task, check if the user or project has saved preferences or conventions. Before asking the user something they may have already told you.\n\nWhen NOT to use: You need the current codebase state (use read_file/grep). You want to save a new fact (there is no save tool yet — mention it to the user).\n\nExample:\n  search_memory(query=\"package manager\")\n  search_memory(query=\"test framework\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "Keyword or phrase to search saved memory facts" },
      limit: { type: "number", description: "Maximum number of facts to return (default 10)" }
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
    description: "List project files as a tree, automatically skipping dependency directories (node_modules, dist, .git, .venv), build output, and sensitive files.\n\nWhen to use: You need a broad overview of the project structure at the start of a task. You want to understand the directory layout before diving into specific files.\n\nWhen NOT to use: You need files matching a specific pattern (use glob). You need to search file contents (use grep). The project is large and you only need a subset.\n\nCaveat: Results are capped at maxFiles (default 200). For large projects, prefer glob with a specific pattern.\n\nExample:\n  list_files()\n  list_files(maxFiles=500)",
    inputSchema: objectSchema({
      maxFiles: { type: "number", description: "Maximum number of file entries to return (default 200, hard cap enforced)" }
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
    description: "Read a UTF-8 text file from inside the project root. Returns the file content; large files are truncated at maxChars with a notice.\n\nWhen to use: You need to inspect or modify a file's content. You are about to edit a file and must read it first. It is always better to speculatively read multiple potentially-useful files as a batch in a single message so they load in parallel.\n\nWhen NOT to use: You only need to know which files exist (use glob or list_files). You need to search for a pattern across many files (use grep). The file is an image or binary (not supported).\n\nIMPORTANT: Before editing a file with edit_file or write_file, you MUST read it first to understand its current content. Attempting to edit without reading leads to incorrect oldText matches.\n\nExample:\n  read_file(path=\"src/App.tsx\")\n  read_file(path=\"package.json\")\n  # Batch read in ONE message (parallel):\n  #   read_file(path=\"src/App.tsx\"), read_file(path=\"src/main.tsx\"), read_file(path=\"vite.config.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "Workspace-relative path to the file (e.g. 'src/App.tsx', 'package.json')" },
      maxChars: { type: "number", description: "Maximum characters to read before truncating (default 200000). Reduce this if you only need the start of a large file." }
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
    description: "Fast structured content search across the project, cross-platform stable (identical behavior on Windows/Linux/macOS). Searches file contents using JavaScript regex. Dangerous regex patterns are rejected; files over 2 MiB and binary files are skipped.\n\nWhen to use: ALWAYS use grep to search for code, strings, or markers (TODO comments, function names, call sites, error logs). This is the primary content search tool.\n\nWhen NOT to use: You need to find files by name/extension (use glob). You need a broad project overview (use list_files). You need to run a shell command (use run_command).\n\nIMPORTANT: NEVER use run_command to run rg/grep/findstr/find — these shell commands fail frequently on Windows+Git Bash due to dialect differences, and they bypass this tool's dependency filtering and sensitive-file protection.\n\nFeatures:\n- pattern: full JavaScript regex (e.g. 'log.*Error', 'function\\\\s+\\\\w+')\n- output_mode: 'files_with_matches' (default, returns only workspace-relative paths — saves tokens, recommended first pass), 'content' (path:line:content), 'count', 'json'\n- Use glob to filter file types (e.g. '**/*.ts'), path to scope a subdirectory, context for surrounding lines (0-3)\n- Set fixed_strings=true when searching for literals containing regex metacharacters (URLs, API keys)\n- Automatically skips node_modules/dist/.git; automatically excludes .env/*.key/id_rsa; output is redacted\n\nExample:\n  grep(pattern=\"TODO\", glob=\"**/*.ts\", output_mode=\"content\", context=2)\n  grep(pattern=\"api.deepseek.com\", fixed_strings=true)",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "JavaScript (ECMAScript) regex pattern to search for. Do NOT use PCRE inline flags like (?i) — use case_sensitive=false instead." },
      path: { type: "string", description: "Optional subdirectory to scope the search (workspace-relative, e.g. 'src/')" },
      glob: { type: "string", description: "Optional minimatch pattern to filter file types (e.g. '**/*.ts', '**/*.{tsx,ts}')" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count", "json"], description: "Result format: 'files_with_matches' (paths only, default), 'content' (path:line:content), 'count' (hits per file), 'json' (structured fields)" },
      case_sensitive: { type: "boolean", description: "Whether the search is case-sensitive (default true). Set to false instead of writing (?i)." },
      fixed_strings: { type: "boolean", description: "Treat pattern as a literal string, escaping regex metacharacters (default false). Use when searching for URLs, API keys, or strings containing special characters." },
      context: { type: "number", description: "Number of context lines to show around each match, 0-3 (default 0)" },
      max_results: { type: "number", description: "Maximum number of matches to return (default 200)" }
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
    description: "Fast file-path matching using minimatch patterns, cross-platform stable (identical behavior on Windows/Linux/macOS). Returns matching workspace-relative file paths sorted by modification time (most recently edited first).\n\nWhen to use: ALWAYS use glob to find files by name, extension, or path pattern (e.g. all .tsx components, test files, config files). This is the primary file-discovery tool.\n\nWhen NOT to use: You need to search file contents (use grep). You need a broad project overview (use list_files). You need to run a shell command (use run_command).\n\nIMPORTANT: NEVER use run_command to run find/ls/Get-ChildItem/dir/where — these shell commands fail frequently on Windows+Git Bash due to dialect differences, and they bypass this tool's dependency filtering.\n\nPattern syntax: ** (cross-directory), * (single segment), {a,b} (enumeration), ? (single char)\n\nExample:\n  glob(pattern=\"src/components/**/*.tsx\")\n  glob(pattern=\"**/*.test.ts\")\n  glob(pattern=\"*.{json,md,yaml}\")\n\nPairs with grep to form the standard 'find files → read content' workflow.",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "Minimatch glob pattern (e.g. 'src/**/*.tsx', '**/*.test.ts', '*.{json,md}')" },
      path: { type: "string", description: "Optional subdirectory to scope the search (workspace-relative)" },
      detail: { type: "boolean", description: "If true, append file size and modification time to each result (default false)" },
      limit: { type: "number", description: "Maximum number of paths to return (default 200)" }
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
    description: "Read the current Git working-tree status and a diff summary. Returns staged/unstaged/untracked file lists and a concise diff.\n\nWhen to use: Before committing, you need to know what changed. After edits, to verify the real diff matches your intent. When the user asks 'what did you change?'.\n\nWhen NOT to use: You need to run arbitrary git commands like commit/push/log (use run_command). You only need to read a specific file (use read_file).\n\nExample:\n  git_status()",
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
    description: "Search the web for current information (new SDKs, error messages, API specs, library docs). Returns a list of results with title, URL, and snippet.\n\nWhen to use: The model's knowledge may be outdated — for new library versions, recent API changes, unfamiliar error messages, or version-specific behavior. The user asks about something recent.\n\nWhen NOT to use: You can find the answer in the local codebase (use grep/glob/read_file). The information is stable and within your training data. You need the full page content (use fetch_url on a specific URL).\n\nIMPORTANT: Web search requires a configured search backend (SEARCH_API_URL + SEARCH_API_KEY environment variables). If unconfigured, the error will guide the user to set it up. Results pass through secret redaction.\n\nWorkflow: web_search to find relevant pages → fetch_url to read the full content of the best result.\n\nExample:\n  web_search(query=\"DeepSeek V4 function calling spec\", limit=5)\n  web_search(query=\"npm ERR! ERESOLVE peer dependency\", allowedDomains=[\"stackoverflow.com\", \"docs.npmjs.com\"])",
    inputSchema: objectSchema({
      query: { type: "string", description: "The search query" },
      limit: { type: "number", description: "Maximum results to return (default 5, max 20)" },
      allowedDomains: { type: "array", items: { type: "string" }, description: "Optional: restrict results to these domains (e.g. ['docs.python.org', 'stackoverflow.com'])" },
      blockedDomains: { type: "array", items: { type: "string" }, description: "Optional: exclude results from these domains" }
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
    description: "Fetch a URL and return its content as Markdown (HTML is converted; JSON and plain text pass through). Large pages are truncated to maxChars.\n\nWhen to use: After web_search identifies a relevant page, use fetch_url to read its full content. You need to read API documentation, a Stack Overflow answer, or a blog post.\n\nWhen NOT to use: You are searching for something but don't have a specific URL yet (use web_search first). The content is in the local project (use read_file).\n\nFeatures:\n- HTML → Markdown conversion (headings, links, lists, code blocks, blockquotes preserved)\n- script/style/nav/footer stripped as noise\n- maxChars truncation (default 20000, max 200000) with a truncation notice\n- Only http/https URLs supported\n- 30-second timeout\n- Output passes through secret redaction\n\nExample:\n  fetch_url(url=\"https://docs.example.com/api/v2\", format=\"markdown\", maxChars=20000)",
    inputSchema: objectSchema({
      url: { type: "string", description: "The http or https URL to fetch" },
      maxChars: { type: "number", description: "Maximum characters to return before truncating (default 20000, max 200000)" },
      format: { type: "string", enum: ["markdown", "text"], description: "Output format: 'markdown' (default, preserves structure) or 'text' (strips markdown syntax)" }
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
    description: "Create a new file or overwrite an existing file with the given complete content.\n\nWhen to use: Creating a new file that does not exist yet. Completely replacing a file's content (e.g. a config rewrite). The file is small enough to output in full.\n\nWhen NOT to use: Modifying part of an existing file (use edit_file — it is cheaper and safer). The file already exists and you have not read it yet.\n\nIMPORTANT: If the file already exists, you MUST read it with read_file first. Overwriting without reading risks losing important content you were not aware of. Prefer edit_file for partial changes — it produces smaller, more reviewable diffs.\n\nExample:\n  write_file(path=\"src/utils/helpers.ts\", content=\"export const add = (a: number, b: number) => a + b;\\n\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "Workspace-relative path to create or overwrite (e.g. 'src/utils/helpers.ts')" },
      content: { type: "string", description: "The complete file content to write" }
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
    description: "Edit an existing file by performing an exact text replacement of oldText with newText.\n\nWhen to use: Modifying a specific part of an existing file. The preferred tool for partial edits — produces minimal, reviewable diffs.\n\nWhen NOT to use: Creating a new file (use write_file). The file does not exist yet.\n\nIMPORTANT: The edit FAILS if oldText is not unique in the file. If it appears multiple times, either provide more surrounding context to make it unique, or set replaceAll=true to replace every occurrence.\n\nExample:\n  edit_file(path=\"src/App.tsx\", oldText=\"const foo = 1;\", newText=\"const foo = 2;\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "Workspace-relative path to the file to edit" },
      oldText: { type: "string", description: "The exact text to find. MUST be unique in the file unless replaceAll is true. Include enough surrounding context to ensure uniqueness." },
      newText: { type: "string", description: "The replacement text" },
      replaceAll: { type: "boolean", description: "If true, replace every occurrence of oldText (default false)" }
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
    description: "Apply multiple exact-text replacements to a single file in one atomic operation. All edits are applied to the in-memory content; the file is written only once after every edit succeeds.\n\nWhen to use: Refactoring a file that needs 3+ coordinated edits (renaming a symbol + updating imports + fixing call sites). Prefer this over multiple sequential edit_file calls — it is faster and produces a single, clean diff.\n\nWhen NOT to use: A single change (use edit_file). Creating a new file (use write_file).\n\nAtomicity guarantee: If ANY oldText fails to match (not found, or ambiguous without replaceAll), the ENTIRE batch is rolled back — no changes are written to disk. The error response lists all failed edits with their index and reason.\n\nIMPORTANT: Each edit's oldText must be unique in the ORIGINAL file content (unless replaceAll is true for that edit). Edits are applied sequentially to the same content buffer, so earlier replacements are visible to later ones — account for this when ordering.\n\nExample:\n  multi_edit(path=\"src/App.tsx\", edits=[\n    {oldText: \"const foo = 1;\", newText: \"const foo = 2;\"},\n    {oldText: \"return null;\", newText: \"return <App/>;\"},\n    {oldText: \"import React\", newText: \"import React, { useState }\"}\n  ])",
    inputSchema: objectSchema({
      path: { type: "string", description: "Workspace-relative path to the file to edit" },
      edits: {
        type: "array",
        minItems: 1,
        description: "Array of edits to apply atomically. All must succeed or none are written.",
        items: objectSchema({
          oldText: { type: "string", description: "The exact text to find. MUST be unique in the file unless replaceAll is true." },
          newText: { type: "string", description: "The replacement text" },
          replaceAll: { type: "boolean", description: "If true, replace every occurrence of oldText (default false)" }
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
    description: "Delete a single file inside the project root. This is a destructive, irreversible operation that requires user approval.\n\nWhen to use: The user explicitly asks to delete a file. A generated file needs to be removed as part of a refactor.\n\nWhen NOT to use: You want to clear a file's content but keep the file (use write_file with empty content, or edit_file). The user did not ask for deletion.\n\nIMPORTANT: Deletion requires user approval and cannot be undone outside of Git. Always confirm the path is correct before calling.\n\nExample:\n  delete_file(path=\"src/legacy/old-module.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "Workspace-relative path to the file to delete" }
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
    description: "Execute a shell command in the project root (builds, tests, git operations, starting processes). This is a managed object: the command runs with a 60-second foreground wait; if still running, it returns a commandId and you MUST use wait_command to continue waiting or stop_command to stop it.\n\nWhen to use: ONLY for genuine shell execution — builds (npm run build), tests (npm test), git operations (git commit), starting dev servers, running scripts.\n\nWhen NOT to use: Searching for code or files — use grep (content search), glob (file search), list_files (file tree), or read_file (read a file) instead.\n\nIMPORTANT: NEVER use run_command to run rg/grep/findstr/find/cat/head/tail/ls — these shell commands fail frequently on Windows+Git Bash due to dialect differences, and they bypass the dedicated tools' dependency filtering and sensitive-file protection.\n\nManaged-command rules:\n- If a command is still running after 60s, you receive a commandId. Use wait_command to continue, or stop_command to terminate it.\n- Do NOT re-run the same long command to poll it — that creates a duplicate. Use wait_command on the existing commandId.\n- A run cannot finish while a managed command is still running. Always wait_command or stop_command before ending.\n\nNon-safe commands (mutations, network access) require user approval. For non-trivial or potentially risky commands (e.g. deletions, force pushes, installs), briefly state in content what the command does and why before calling — this helps the user understand the action before approving.\n\nExample:\n  run_command(command=\"npm run build\")\n  run_command(command=\"npm test\")\n  run_command(command=\"git add -A && git commit -m 'feat: add login page'\")",
    inputSchema: objectSchema({
      command: { type: "string", description: "The shell command to execute (e.g. 'npm run build', 'git status', 'npx tsc --noEmit')" }
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
    description: "Wait for a still-running managed command. Returns incremental output (stdout/stderr since the last poll) and blocks up to 60 seconds; returns early if the command exits.\n\nWhen to use: A run_command returned a commandId because the command was still running after 60 seconds. You need to collect more output or confirm the command finished.\n\nWhen NOT to use: The command already exited (its result was returned directly). You want to stop a command instead of waiting (use stop_command).\n\nIMPORTANT: Do NOT re-run the original command to poll it. That creates a duplicate managed object. Always wait_command on the existing commandId.\n\nExample:\n  wait_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "The commandId returned by run_command when the command was still running" }
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
    description: "Stop a managed command and its full process tree. Safe to call on an already-stopped or exited command (idempotent).\n\nWhen to use: A long-running command (e.g. a dev server) is no longer needed and you want to terminate it. The run cannot finish while a command is still running, and you do not want to wait for it.\n\nWhen NOT to use: You want to keep waiting for the command (use wait_command).\n\nExample:\n  stop_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "The commandId of the managed command to stop" }
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
    description: "Request entering plan mode, before any side effects have been produced. Plan mode restricts you to read-only operations (read, search, ask questions, form a proposal) — no workspace modifications or external side effects.\n\nWhen to use: The task is complex, cross-module, involves significant tradeoffs, a migration, security risk, or is hard to roll back. The user explicitly asked for a plan.\n\nWhen NOT to use: The task is simple and unambiguous — just do it. You have already started modifying files (plan mode is for pre-implementation only).\n\nIMPORTANT: enter_plan may suspend the run until the user confirms. It MUST be called alone (not batched with other tools).\n\nExample:\n  enter_plan(reason=\"This refactor touches 12 files across 3 modules and has migration risk\")",
    inputSchema: objectSchema({
      reason: { type: "string", description: "Why plan mode is warranted for this task (e.g. 'This refactor touches 12 files across 3 modules and has migration risk')" }
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
    description: "Ask the user 1-3 short questions that materially affect the plan, then wait for their answers. Each question can offer 2-3 options or be open-ended.\n\nWhen to use: In plan mode, you have gathered enough context to form a proposal but need key decisions from the user before the plan is complete (e.g. 'Which library: A or B?', 'Should we migrate now or keep backward compatibility?').\n\nWhen NOT to use: You already have enough information to submit the plan (use submit_plan). You are in work mode (ask_user is plan-mode only). The question is trivial and does not affect the plan.\n\nIMPORTANT: Only ask questions whose answers change the plan. Do not ask for information you could find yourself with tools.\n\nExample:\n  ask_user(questions=[\n    {questionId: \"q1\", label: \"Library\", prompt: \"Which state management library should we use?\", options: [\"Zustand\", \"Redux\", \"Jotai\"]},\n    {questionId: \"q2\", label: \"Migration\", prompt: \"Should we migrate now or keep backward compatibility?\"}\n  ])",
    inputSchema: objectSchema({
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: objectSchema({
          questionId: { type: "string", description: "Unique identifier for this question (used in the answer mapping)" },
          label: { type: "string", description: "Short label shown as a chip/header (max 12 chars)" },
          prompt: { type: "string", description: "The full question text" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3, description: "2-3 predefined options. Omit for an open-ended question." }
        }, ["questionId", "label", "prompt"]),
        description: "1-3 questions for the user. Each must have a material impact on the plan."
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
    description: "Submit a decision-complete implementation plan as Markdown for the user to review. After submission, the run suspends and waits for the user's decision — you MUST NOT start implementation on your own.\n\nWhen to use: In plan mode, your proposal is decision-complete (all key choices are made, no open questions). You have finished ask_user rounds and are ready for approval.\n\nWhen NOT to use: You still have open questions (use ask_user first). You are in work mode (just do the work). The task is simple enough that a plan is unnecessary.\n\nIMPORTANT: The plan must be a complete, actionable Markdown document — not a vague outline. Include: what changes, why, file-level steps, risks, and verification commands.\n\nExample:\n  submit_plan(title=\"Add JWT authentication\", markdown=\"## Objective\\nSecure the API with JWT...\\n## Steps\\n1. Install jsonwebtoken\\n2. Create auth middleware\\n3. Add login route\\n## Verification\\n- npm test\\n- curl localhost:3000/login\")",
    inputSchema: objectSchema({
      title: { type: "string", description: "Short title for the plan (e.g. 'Add user authentication with JWT')" },
      markdown: { type: "string", description: "Full plan body in Markdown — include objective, approach, file-level steps, risks, and verification" }
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
    description: "Create or replace the execution task list for the current run. Tasks track progress in work mode — they are for your own execution tracking, not for user plan approval.\n\nWhen to use: The task has 3+ discrete steps that span multiple files or phases (e.g. 'rename symbol across codebase' = read usages → edit imports → edit call sites → run typecheck). You want to show the user your progress as you work. A complex bug fix with multiple investigation steps.\n\nWhen NOT to use: Simple Q&A or single-file edits (just do the work). A 1-2 step task. You are in plan mode (use submit_plan instead).\n\nIMPORTANT: Call update_tasks at the START of a complex task to lay out the steps, then update each task's status as you complete it. Keep exactly one task 'running' at a time. This is not for plan approval — it is for execution transparency.\n\nExample (high-quality task list for 'add dark mode'):\n  update_tasks(tasks=[\n    {taskId:'t1', label:'Read current theme system', status:'running'},\n    {taskId:'t2', label:'Add CSS variables for dark palette', status:'pending'},\n    {taskId:'t3', label:'Wire theme toggle in Settings', status:'pending'},\n    {taskId:'t4', label:'Verify with build + manual test', status:'pending'}\n  ])",
    inputSchema: objectSchema(
      {
        tasks: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              label: { type: "string", description: "Human-readable description of this task step" },
              status: { type: "string", enum: ["pending", "running", "completed", "blocked"], description: "Current status: 'pending' (not started), 'running' (in progress — keep exactly one at a time), 'completed', 'blocked'" },
              taskId: { type: "string", description: "Unique identifier for this task" }
            },
            ["taskId", "label", "status"]
          ),
          description: "The full task list — replaces any previous list. Include all steps, not just changed ones."
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
    description: "Launch a new agent to handle complex, multi-step tasks. The sub-agent runs in an isolated session — only its final summary enters the parent conversation, not its intermediate steps.\n\nWhen to use: Searching across many files for a keyword or pattern (the sub-agent explores without polluting your context). Exploring an unfamiliar codebase area. Multi-directional research that can run in parallel (e.g. 'find test patterns AND routing structure AND DB schema'). Any task where the intermediate exploration would consume too much context.\n\nWhen NOT to use: Reading a specific known file (use read_file). A simple single-pattern search (use grep). Any task solvable in 1-2 tool calls. You need the user to see every step (sub-agent steps are hidden).\n\nSub-agent types:\n- 'Explore' (read-only: read_file, grep, glob, list_files, git_status, search_memory) — for investigation and research\n- 'general-purpose' (full toolset except spawn_agent) — for tasks that need edits or command execution\n\nReturns: Only the sub-agent's final text summary. Intermediate tool calls and reasoning do NOT enter the parent conversation.\n\nParallelism: Multiple spawn_agent calls in a single message run concurrently — use this for independent research tasks.\n\nIMPORTANT: Sub-agents cannot spawn further sub-agents (no recursion). The sub-agent's prompt should be self-contained — include all context it needs, since it starts fresh.\n\nExample:\n  spawn_agent(description='Find all uncaught promise rejections', prompt='Scan all .ts files under src/ for .then() chains without .catch(). Report file:line for each finding.', subagentType='Explore')",
    inputSchema: objectSchema({
      description: { type: "string", description: "Short 3-5 word description of the task (for logging and the activity timeline)" },
      prompt: { type: "string", description: "The complete, self-contained task prompt for the sub-agent. Include all necessary context — the sub-agent does not see the parent conversation." },
      subagentType: { type: "string", enum: ["Explore", "general-purpose"], description: "'Explore' = read-only research tools; 'general-purpose' = full toolset (can edit files, run commands)" }
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
  return {
    byteCount: Buffer.byteLength(output),
    exitCode: result.exitCode,
    itemCount: name === "list_files" || name === "glob" ? lines : name === "read_file" || action === "modify" ? 1 : undefined,
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
