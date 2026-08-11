import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApplyPatchHunk, parseApplyPatch } from "../../domain/applyPatch";
import { ensureInsideRoot } from "./security";

function sameLines(left: string[], right: string[], start: number, relaxed: boolean): boolean {
  if (start + left.length > right.length) return false;
  return left.every((line, offset) => relaxed
    ? line.trimEnd() === right[start + offset].trimEnd()
    : line === right[start + offset]);
}

function matchingLines(source: string[], pattern: string[], from: number, relaxed: boolean): number[] {
  const matches: number[] = [];
  for (let index = from; index <= source.length - pattern.length; index += 1) {
    if (sameLines(pattern, source, index, relaxed)) matches.push(index);
  }
  return matches;
}

function findAnchor(source: string[], anchor: string, from: number): number {
  const exact = source.findIndex((line, index) => index >= from && line === anchor);
  if (exact >= 0) return exact;
  return source.findIndex((line, index) => index >= from && line.trim() === anchor.trim());
}

function findHunk(source: string[], pattern: string[], from: number, anchored: boolean): number {
  for (const relaxed of [false, true]) {
    const matches = matchingLines(source, pattern, from, relaxed);
    if (matches.length > 1 && !anchored) return -2;
    if (matches.length > 0) return matches[0];
  }
  return -1;
}

function applyHunks(filePath: string, contents: string, hunks: ApplyPatchHunk[]): string {
  const trailingNewline = contents.endsWith("\n");
  const source = contents.replaceAll("\r\n", "\n").split("\n");
  if (trailingNewline) source.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const anchorIndex = hunk.anchor ? findAnchor(source, hunk.anchor, cursor) : -1;
    if (hunk.anchor && anchorIndex < 0) {
      throw new Error(`apply_patch 无法在 ${filePath} 中定位锚点 ${hunk.anchor}。补丁草稿未应用。`);
    }
    if (before.length === 0 && !hunk.anchor) {
      throw new Error(`apply_patch 在 ${filePath} 中包含没有上下文或锚点的插入。补丁草稿未应用。`);
    }
    const searchFrom = anchorIndex >= 0 ? anchorIndex : cursor;
    const found = before.length === 0 ? anchorIndex + 1 : findHunk(source, before, searchFrom, anchorIndex >= 0);
    if (found === -2) throw new Error(`apply_patch 在 ${filePath} 中的 hunk 匹配多处，请增加 @@ 锚点或上下文。补丁草稿未应用。`);
    if (found < 0) throw new Error(`apply_patch 无法在 ${filePath} 中定位 hunk。补丁草稿未应用。`);
    source.splice(found, before.length, ...after);
    cursor = found + after.length;
  }
  return source.join("\n") + (trailingNewline ? "\n" : "");
}

export async function applyPatch(projectRoot: string, input: { patch: string }, ctx?: { runId?: string; fileState?: { recordWrite(runId: string | undefined, projectRoot: string, rawPath: string, contents: string): void } }): Promise<string> {
  const operations = parseApplyPatch(String(input.patch ?? ""));
  if (operations.length === 0) throw new Error("apply_patch 没有包含文件操作。补丁草稿未应用。");
  const staged = new Map<string, string | null>();
  const normalize = (relativePath: string): string => path.relative(
    path.resolve(projectRoot),
    ensureInsideRoot(projectRoot, relativePath)
  ).split(path.sep).join("/");
  const read = async (relativePath: string): Promise<string> => {
    const normalized = normalize(relativePath);
    if (staged.has(normalized)) {
      const value = staged.get(normalized);
      if (value === null) throw new Error(`apply_patch 目标 ${relativePath} 已在当前补丁中删除。补丁草稿未应用。`);
      return value!;
    }
    return fs.readFile(ensureInsideRoot(projectRoot, normalized), "utf8");
  };
  for (const operation of operations) {
    const operationPath = normalize(operation.path);
    if (operation.kind === "add") {
      const target = ensureInsideRoot(projectRoot, operationPath);
      const exists = await fs.access(target).then(() => true).catch(() => false);
      if (exists || staged.has(operationPath)) throw new Error(`apply_patch 不能新增已存在文件 ${operation.path}。补丁草稿未应用。`);
      staged.set(operationPath, operation.lines.join("\n") + (operation.lines.length > 0 ? "\n" : ""));
      continue;
    }
    if (operation.kind === "delete") {
      await read(operation.path);
      staged.set(operationPath, null);
      continue;
    }
    const updated = applyHunks(operation.path, await read(operation.path), operation.hunks);
    if (operation.moveTo) {
      const moveTo = normalize(operation.moveTo);
      const destination = ensureInsideRoot(projectRoot, moveTo);
      const destinationExists = staged.has(moveTo)
        ? staged.get(moveTo) !== null
        : await fs.access(destination).then(() => true).catch(() => false);
      if (destinationExists) throw new Error(`apply_patch 不能移动到已存在文件 ${operation.moveTo}。补丁草稿未应用。`);
      staged.set(operationPath, null);
      staged.set(moveTo, updated);
    } else {
      staged.set(operationPath, updated);
    }
  }
  const transactionId = randomUUID().replaceAll("-", "");
  type PreparedEntry = {
    backup?: string;
    contents: string | null;
    original: Buffer | null;
    originalMode?: number;
    relativePath: string;
    target: string;
    temporary?: string;
  };
  const prepared: PreparedEntry[] = [];
  try {
    for (const [relativePath, contents] of staged) {
      const target = ensureInsideRoot(projectRoot, relativePath);
      const original = await fs.readFile(target).then((value) => value, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const suffix = `.deepcreator-apply-patch-${transactionId}-${prepared.length}`;
      const originalMode = original === null ? undefined : (await fs.stat(target)).mode & 0o7777;
      const temporary = contents === null ? undefined : path.join(path.dirname(target), `${path.basename(target)}${suffix}.tmp`);
      const backup = original === null ? undefined : path.join(path.dirname(target), `${path.basename(target)}${suffix}.bak`);
      if (temporary && contents !== null) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
          await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
          if (originalMode !== undefined) await fs.chmod(temporary, originalMode);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      prepared.push({ backup, contents, original, originalMode, relativePath, target, temporary });
    }
  } catch (error) {
    await Promise.all(prepared.flatMap((entry) => [entry.temporary, entry.backup]
      .filter(Boolean)
      .map((target) => fs.rm(target!, { force: true }).catch(() => undefined))));
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`apply_patch 无法准备原子提交，所有文件保持不变：${detail}`);
  }
  const committed: typeof prepared = [];
  try {
    for (const entry of prepared) {
      if (entry.original !== null && entry.backup) await fs.rename(entry.target, entry.backup);
      committed.push(entry);
      if (entry.temporary) await fs.rename(entry.temporary, entry.target);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of [...committed].reverse()) {
      try {
        if (entry.temporary) await fs.rm(entry.target, { force: true });
        if (entry.backup) await fs.rename(entry.backup, entry.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    await Promise.all(prepared.flatMap((entry) => [entry.temporary, entry.backup].filter(Boolean).map((target) => fs.rm(target!, { force: true }).catch(() => undefined))));
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length > 0
      ? `apply_patch 提交失败且回滚不完整：${detail}；${rollbackErrors.join("；")}`
      : `apply_patch 提交失败，已回滚全部文件：${detail}`);
  }
  await Promise.all(prepared.flatMap((entry) => [entry.temporary, entry.backup]
    .filter(Boolean)
    .map((target) => fs.rm(target!, { force: true }).catch(() => undefined))));
  if (ctx?.fileState && ctx.runId) {
    for (const [relativePath, contents] of staged) {
      if (contents !== null) ctx.fileState.recordWrite(ctx.runId, projectRoot, relativePath, contents);
    }
  }
  return `已应用补丁，涉及 ${staged.size} 个文件`;
}
