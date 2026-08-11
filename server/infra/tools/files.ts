import { promises as fs } from "node:fs";
import path from "node:path";
import { ArtifactEntry } from "../../../shared/contracts/runtime";
import { stableDigest } from "../../../shared/domain/digest";
import type { FileStateStore } from "../../app/fileStateStore";
import { ensureInsideRoot, isSensitivePath } from "./security";
import { splitLines, joinLines, locateLineMatches, nearestLine } from "./textMatch";
import { generateUnifiedDiff } from "./diff";

export type FileToolContext = { runId?: string; fileState?: FileStateStore };

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

export async function listFiles(projectRoot: string, input: { maxFiles?: number }): Promise<string> {
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

// 扫描 <projectRoot>/output/ 子树(agent 生成内容的约定目录 —— 与 listFiles「排除 output」相反),
// 返回结构化产物列表(相对 output/ 的 path + size + mtime),供 Inspector「输出」段按项目跨会话展示。
// 沿用 ensureInsideRoot 限定根、isSensitivePath 跳过密钥文件;output/ 不存在或为空返回 []。
export async function listArtifacts(projectRoot: string): Promise<ArtifactEntry[]> {
  const root = ensureInsideRoot(projectRoot);
  const outputDir = path.join(root, "output");
  const entries: ArtifactEntry[] = [];
  async function walk(current: string): Promise<void> {
    let listing: import("node:fs").Dirent[];
    try {
      listing = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限 → 当作空
    }
    for (const entry of listing) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(fullPath);
      } else if (!isSensitivePath(entry.name)) {
        try {
          const stat = await fs.stat(fullPath);
          entries.push({
            mtime: stat.mtime.toISOString(),
            path: path.relative(outputDir, fullPath).split(path.sep).join("/"),
            size: stat.size
          });
        } catch {
          // 文件中途被删/不可读 → 跳过
        }
      }
    }
  }
  await walk(outputDir);
  entries.sort((left, right) => right.mtime.localeCompare(left.mtime)); // newest-first
  return entries;
}

export async function readFile(projectRoot: string, input: { path: string; maxChars?: number }, ctx?: FileToolContext): Promise<string> {
  if (isSensitivePath(input.path)) throw new Error("出于安全原因，Runtime 不允许读取密钥或凭据文件。");
  const contents = await fs.readFile(ensureInsideRoot(projectRoot, input.path), "utf8");
  if (ctx?.fileState && ctx.runId) ctx.fileState.recordRead(ctx.runId, projectRoot, input.path, contents);
  const maxChars = Math.min(200_000, Math.max(1, input.maxChars ?? 40_000));
  return contents.slice(0, maxChars);
}

export async function writeFile(projectRoot: string, input: { path: string; content: string }, ctx?: FileToolContext): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existed = await fs.access(filePath).then(() => true).catch(() => false);
  await fs.writeFile(filePath, input.content, "utf8");
  if (ctx?.fileState && ctx.runId) ctx.fileState.recordWrite(ctx.runId, projectRoot, input.path, input.content);
  return `${existed ? "已编辑" : "已创建"} ${input.path}`;
}

type EditInput = { oldText: string; newText: string; replaceAll?: boolean };
type ApplyResult = { result?: string; error?: string };

// 对 contents 应用一处 edit:strict 子串(split/replace,完全向后兼容)→ strict=0 降级 relaxed 行匹配
// (trimEnd 尾随空白容错)。error 简短码:未找到 / 多处(N) / 模糊(N)。caller 包装 path + 上下文。
function applyEditStrictRelaxed(contents: string, edit: EditInput): ApplyResult {
  const occurrences = contents.split(edit.oldText).length - 1;
  if (occurrences > 0) {
    if (occurrences > 1 && !edit.replaceAll) return { error: `多处(${occurrences})` };
    const next = edit.replaceAll
      ? contents.split(edit.oldText).join(edit.newText)
      : contents.replace(edit.oldText, edit.newText);
    return { result: next };
  }
  const { lines: sourceLines, trailingNewline } = splitLines(contents);
  const patternLines = splitLines(edit.oldText).lines;
  if (patternLines.length === 0) return { error: "未找到" };
  const relaxed = locateLineMatches(sourceLines, patternLines).relaxed;
  if (relaxed.length > 1 && !edit.replaceAll) return { error: `模糊(${relaxed.length})` };
  if (relaxed.length === 0) return { error: "未找到" };
  const newTextLines = splitLines(edit.newText).lines;
  const targets = edit.replaceAll ? relaxed : [relaxed[0]];
  for (const start of [...targets].sort((left, right) => right - left)) {
    sourceLines.splice(start, patternLines.length, ...newTextLines);
  }
  return { result: joinLines(sourceLines, trailingNewline) };
}

export async function editFile(
  projectRoot: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean },
  ctx?: FileToolContext
): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const contents = await fs.readFile(filePath, "utf8");
  if (!input.oldText) throw new Error("oldText 不能为空。创建文件请使用 write_file。");
  if (ctx?.fileState && ctx.runId) {
    const expected = ctx.fileState.hashFor(ctx.runId, projectRoot, input.path);
    if (expected !== undefined && stableDigest(contents) !== expected) {
      throw new Error(`文件 ${input.path} 自上次 read_file 后已被修改（内容指纹不一致），编辑已中止以防覆盖外部改动。请重新 read_file 后再编辑。`);
    }
  }
  const applied = applyEditStrictRelaxed(contents, input);
  if (applied.error) {
    if (applied.error === "未找到") {
      const near = nearestLine(splitLines(contents).lines, input.oldText);
      const hint = near >= 0 ? `，第 ${near + 1} 行附近有相似内容` : "";
      throw new Error(`未在 ${input.path} 中找到 oldText（精确与忽略尾随空白均不匹配${hint}）。`);
    }
    const count = applied.error.match(/\((\d+)\)/)?.[1] ?? "?";
    if (applied.error.startsWith("多处")) {
      throw new Error(`oldText 在 ${input.path} 中出现 ${count} 次，请提供更精确文本。`);
    }
    throw new Error(`oldText 在 ${input.path} 中模糊匹配 ${count} 处（已尝试忽略尾随空白），请提供更多上下文。`);
  }
  await fs.writeFile(filePath, applied.result!, "utf8");
  if (ctx?.fileState && ctx.runId) ctx.fileState.recordWrite(ctx.runId, projectRoot, input.path, applied.result!);
  const diff = generateUnifiedDiff(input.path, contents, applied.result!);
  return `已编辑 ${input.path}\n\n${diff}`;
}

export async function deleteFile(projectRoot: string, input: { path: string }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("delete_file 只能删除文件。");
  await fs.unlink(filePath);
  return `已删除 ${input.path}`;
}

/**
 * 原子批量编辑:对单个文件依次应用多个 oldText→newText 替换。
 * 核心保证:任一 oldText 不匹配则整批回滚(不写盘),返回所有失败项的详细清单。
 * 全部成功后才写一次磁盘——产生单次 checkpoint + 单个 changes 事件。
 *
 * 实现细节:edits 是链式应用的——edit[1] 看到的是 edit[0] 应用后的内容。
 * 校验在链式应用过程中进行:每个 edit 在其"前序 edit 已应用"的内容上校验唯一性。
 * 收集所有失败项后统一抛出(任一失败则不写盘)。
 */
export async function multiEdit(
  projectRoot: string,
  input: { path: string; edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }> },
  ctx?: FileToolContext
): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const original = await fs.readFile(filePath, "utf8");
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edits 不能为空。单处编辑请使用 edit_file。");
  }
  if (ctx?.fileState && ctx.runId) {
    const expected = ctx.fileState.hashFor(ctx.runId, projectRoot, input.path);
    if (expected !== undefined && stableDigest(original) !== expected) {
      throw new Error(`文件 ${input.path} 自上次 read_file 后已被修改（内容指纹不一致），编辑已中止以防覆盖外部改动。请重新 read_file 后再编辑。`);
    }
  }
  // 链式校验+应用:在内存中逐步应用,任一 edit 在其当前内容上校验失败则记录。
  let workingCopy = original;
  const failures: Array<{ index: number; reason: string }> = [];
  for (let index = 0; index < input.edits.length; index += 1) {
    const edit = input.edits[index];
    if (!edit.oldText) {
      failures.push({ index, reason: "oldText 不能为空" });
      continue;
    }
    const applied = applyEditStrictRelaxed(workingCopy, edit);
    if (applied.error) {
      const detail = applied.error === "未找到"
        ? "未找到 oldText（精确与忽略尾随空白均不匹配）"
        : applied.error.startsWith("多处")
          ? `oldText 出现 ${applied.error.match(/\((\d+)\)/)?.[1] ?? "?"} 次,需提供更精确文本或设 replaceAll=true`
          : `oldText 模糊匹配 ${applied.error.match(/\((\d+)\)/)?.[1] ?? "?"} 处（忽略尾随空白）`;
      failures.push({ index, reason: detail });
      continue;
    }
    workingCopy = applied.result!;
  }
  if (failures.length > 0) {
    const detail = failures.map((failure) => `  edit[${failure.index}]: ${failure.reason}`).join("\n");
    throw new Error(`multi_edit 因 ${failures.length} 处匹配失败而回滚,文件未修改:\n${detail}`);
  }
  // 全部成功,写盘一次
  await fs.writeFile(filePath, workingCopy, "utf8");
  if (ctx?.fileState && ctx.runId) ctx.fileState.recordWrite(ctx.runId, projectRoot, input.path, workingCopy);
  const diff = generateUnifiedDiff(input.path, original, workingCopy);
  return `已原子编辑 ${input.path}(${input.edits.length} 处替换)\n\n${diff}`;
}
