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
import { deleteFile, editFile, listFiles, readFile, writeFile } from "./tools/files";

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
  if (name === "delete_file") return { mutatedWorkspace: true, output: await deleteFile(projectRoot, args as never) };
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

const toolRegistry: ToolRegistration[] = [
  {
    name: "search_capabilities",
    description: "搜索未前置加载的项目 Skill、MCP 或长尾能力。返回简短元数据，不加载完整说明。",
    inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "能力目录")
    }
  },
  {
    name: "invoke_capability",
    description: "按 capabilityId 启用一个已发现的长尾能力。Skill 正文会作为独立 ContextUpdate 注入。",
    inputSchema: objectSchema({ capabilityId: { type: "string" }, arguments: { additionalProperties: true, type: "object" } }, ["capabilityId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.capabilityId ?? "能力")
    }
  },
  {
    name: "search_memory",
    description: "按关键词读取经过用户确认的结构化 MemoryFact。只读，不会自动创建记忆。",
    inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "Memory")
    }
  },
  {
    name: "list_files",
    description: "列出项目文件，忽略依赖、Git 和构建目录。",
    inputSchema: objectSchema({ maxFiles: { type: "number" } }),
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
    name: "read_file",
    description: "读取项目根目录内的 UTF-8 文本文件。",
    inputSchema: objectSchema({ path: { type: "string" }, maxChars: { type: "number" } }, ["path"]),
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
    name: "grep",
    description: "基于结构化扫描的快速内容搜索工具,适配大型代码库,跨平台稳定(Windows/Linux/macOS 行为一致)。\nALWAYS use grep for search tasks. NEVER 用 run_command 跑 rg/grep/findstr/find —— 这些命令在 Windows+Git Bash 环境会因 shell 方言差异频繁失败,且会绕过本工具的依赖目录过滤与敏感文件保护。\n用法:\n- 需要找代码/字符串/标记(如 TODO、函数名、调用点、错误日志)时必用此工具\n- pattern 支持 JavaScript 正则(如 \"log.*Error\"、\"function\\s+\\w+\");危险正则会被拒绝,PCRE 的 (?i) 内联标志会被自动归一化\n- output_mode:files_with_matches 默认(只返回工作区相对路径,推荐先用这个看哪些文件命中)、content(path:line:content)、count(每文件命中数)、json(结构化字段)\n- 用 glob 过滤文件类型(如 \"**/*.ts\"),用 path 限定子目录,context 取上下文行(0-3)\n- 搜索含正则元字符的字面量(URL、API key)设 fixed_strings=true\n- 自动跳过 node_modules/dist/.git、超过 2 MiB 的单文件和二进制文件;自动排除 .env/*.key/id_rsa 等敏感文件,输出脱敏",
    inputSchema: objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count", "json"] },
      case_sensitive: { type: "boolean" },
      fixed_strings: { type: "boolean" },
      context: { type: "number" },
      max_results: { type: "number" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "搜索")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "搜索")
    }
  },
  {
    name: "glob",
    description: "基于 minimatch 的快速文件路径匹配工具,跨平台稳定(Windows/Linux/macOS 行为一致)。\nALWAYS use glob for file search tasks. NEVER 用 run_command 跑 find/ls/Get-ChildItem/dir/where —— 这些命令在 Windows+Git Bash 环境会因 shell 方言差异频繁失败,且会绕过本工具的依赖目录过滤与敏感文件保护。\n用法:\n- 需要按文件名/扩展名/路径模式找文件(如所有 .tsx 组件、tests 下的测试文件、配置文件)时必用此工具\n- pattern 语法:** 跨目录、* 单段、{a,b} 枚举、? 单字符(如 \"src/**/*.tsx\"、\"**/*.test.ts\"、\"*.{json,md}\")\n- 结果返回工作区相对路径,并按修改时间倒序排列(最近改过的文件排前面)\n- 可用 path 限定子目录,detail=true 附加 size/mtime,limit 截断(默认 200)\n- 自动跳过 node_modules/dist/.git/.deepseeker 等,自动排除 .env/*.key/id_rsa 等敏感文件\n- 与 grep 配合形成 \"找文件 → 看内容\" 标准动作链",
    inputSchema: objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      detail: { type: "boolean" },
      limit: { type: "number" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "directory",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "匹配")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "匹配")
    }
  },
  {
    name: "git_status",
    description: "读取工作区 Git 状态和差异摘要。",
    inputSchema: objectSchema({}),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: () => "Git 工作区"
    }
  },
  {
    name: "write_file",
    description: "创建文件或用完整内容覆盖现有文件。",
    inputSchema: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
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
    name: "edit_file",
    description: "通过精确文本替换编辑现有文件。",
    inputSchema: objectSchema({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, ["path", "oldText", "newText"]),
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
    name: "delete_file",
    description: "删除项目根目录内的单个文件，需要用户批准。",
    inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
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
    name: "run_command",
    description: "在项目根目录运行 shell 命令(构建/测试/git/启动进程等)。最多前台等待 60 秒；若仍在运行会返回 commandId，必须使用 wait_command 继续等待或 stop_command 停止，不要重复启动同一命令。非安全命令需要用户批准。【本工具只用于执行真实 shell 命令,不要用它搜索代码/文件——搜内容用 grep 工具,找文件用 glob 工具,list_files 列文件树,read_file 读文件。用 run_command 跑 rg/grep/findstr/find/cat 在 Windows+Git Bash 环境会因 shell 方言差异频繁失败】",
    inputSchema: objectSchema({ command: { type: "string" } }, ["command"]),
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
    name: "wait_command",
    description: "等待一个仍在运行的命令，最多等待 60 秒并返回增量输出；命令退出时会提前返回。",
    inputSchema: objectSchema({ commandId: { type: "string" } }, ["commandId"]),
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
    name: "stop_command",
    description: "停止一个托管命令及其完整进程树。重复停止同一命令是安全的。",
    inputSchema: objectSchema({ commandId: { type: "string" } }, ["commandId"]),
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
    name: "enter_plan",
    description: "在实施尚未产生副作用时请求进入计划模式。仅用于复杂、含重大取舍或难以回滚的工作。",
    inputSchema: objectSchema({ reason: { type: "string" } }, ["reason"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "计划模式"
    }
  },
  {
    name: "ask_user",
    description: "在计划模式中提出一至三个会实质影响方案的简短问题，并等待用户回答。",
    inputSchema: objectSchema({
      questions: {
        items: objectSchema({
          questionId: { type: "string" },
          label: { type: "string" },
          prompt: { type: "string" },
          options: { items: { type: "string" }, maxItems: 3, minItems: 2, type: "array" }
        }, ["questionId", "label", "prompt"]),
        maxItems: 3,
        minItems: 1,
        type: "array"
      }
    }, ["questions"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "方案问题"
    }
  },
  {
    name: "submit_plan",
    description: "提交一份决策完整、可供用户审阅的 Markdown 实施方案。提交后等待用户决定，不会自行开始实施。",
    inputSchema: objectSchema({ title: { type: "string" }, markdown: { type: "string" } }, ["title", "markdown"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "实施方案"
    }
  },
  {
    name: "update_tasks",
    description: "建立或替换当前运行的执行任务清单。简单问答不要调用。",
    inputSchema: objectSchema(
      {
        tasks: {
          items: objectSchema(
            {
              label: { type: "string" },
              status: { enum: ["pending", "running", "completed", "blocked"], type: "string" },
              taskId: { type: "string" }
            },
            ["taskId", "label", "status"]
          ),
          minItems: 1,
          type: "array"
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
      resolveTarget: () => "执行任务"
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
    write_file: "写入文件"
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
