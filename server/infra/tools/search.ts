import { promises as fs } from "node:fs";
import path from "node:path";
import { Minimatch } from "minimatch";
import safeRegex from "safe-regex2";
import {
  ensureInsideRoot,
  isSensitivePath,
  redactSensitiveText
} from "./security";

const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_BINARY_SAMPLE_BYTES = 8 * 1024;
const GREP_MAX_PATTERN_CHARS = 2_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".deepcreator",
  ".playwright-cli",
  ".pytest_cache",
  ".venv",
  "dist",
  "node_modules",
  "output"
]);

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
    const negatedSeen: string[] = [];
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

export async function grepFiles(
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

  function reachedLimit(): boolean {
    if ((wantContent || wantJson) && lineHitCount >= maxLineHits) return true;
    return (mode === "files_with_matches" || wantCount) && fileHitCount >= maxFiles;
  }

  async function inspectFile(fullPath: string, matchPath: string): Promise<void> {
    if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    if (reachedLimit()) return;
    if (isSensitivePath(path.basename(fullPath))) return;
    if (globFilter && !globFilter.match(matchPath)) return;
    const relativePath = path.relative(workspaceRoot, fullPath).replaceAll("\\", "/");
    let contents: string;
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) return;
      if (stat.size > GREP_MAX_FILE_BYTES) {
        skippedLargeFiles += 1;
        return;
      }
      const buffer = await fs.readFile(fullPath);
      if (buffer.byteLength > GREP_MAX_FILE_BYTES) {
        skippedLargeFiles += 1;
        return;
      }
      if (buffer.subarray(0, GREP_BINARY_SAMPLE_BYTES).includes(0)) {
        skippedBinaryFiles += 1;
        return;
      }
      contents = buffer.toString("utf8");
    } catch {
      // 二进制或无权限文件,跳过
      return;
    }
    const lines = contents.split("\n");
    let fileMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      if ((wantContent || wantJson) && lineHitCount >= maxLineHits) break;
      regex.lastIndex = 0;
      const match = regex.exec(lines[i]);
      if (!match) continue;
      fileMatches += 1;
      if (mode === "files_with_matches") break;
      if (wantCount) continue;
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

  async function walk(current: string): Promise<void> {
    if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
    if (reachedLimit()) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (signal?.aborted) throw new DOMException("运行已取消。", "AbortError");
      if (reachedLimit()) return;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const matchPath = path.relative(root, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      await inspectFile(fullPath, matchPath);
    }
  }

  const rootStat = await fs.stat(root);
  if (rootStat.isFile()) {
    await inspectFile(root, path.basename(root));
  } else {
    await walk(root);
  }

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

export async function globFiles(
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
