export type ApplyPatchHunk = { anchor?: string; lines: string[] };

export type ApplyPatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: ApplyPatchHunk[] };

export function parseApplyPatch(patch: string): ApplyPatchOperation[] {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") throw new Error("apply_patch 缺少 *** Begin Patch。\n补丁草稿未应用。");
  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const header = lines[index];
    if (header === "*** End Patch") return operations;
    const match = header.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (!match) throw new Error(`apply_patch 第 ${index + 1} 行不是有效文件头。补丁草稿未应用。`);
    const kind = match[1].toLowerCase() as "add" | "delete" | "update";
    const filePath = match[2].trim();
    if (!filePath) throw new Error("apply_patch 文件路径不能为空。补丁草稿未应用。");
    index += 1;
    if (kind === "delete") {
      operations.push({ kind, path: filePath });
      continue;
    }
    if (kind === "add") {
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) throw new Error(`新增文件 ${filePath} 的内容行必须以 + 开头。补丁草稿未应用。`);
        content.push(lines[index].slice(1));
        index += 1;
      }
      operations.push({ kind, lines: content, path: filePath });
      continue;
    }
    let moveTo: string | undefined;
    if (lines[index]?.startsWith("*** Move to: ")) {
      moveTo = lines[index].slice("*** Move to: ".length).trim();
      index += 1;
    }
    const hunks: ApplyPatchHunk[] = [];
    let current: string[] = [];
    let currentAnchor: string | undefined;
    while (index < lines.length && !lines[index].startsWith("*** ")) {
      if (lines[index].startsWith("@@")) {
        if (current.length > 0) hunks.push({ anchor: currentAnchor, lines: current });
        current = [];
        currentAnchor = lines[index].slice(2).trim() || undefined;
      } else {
        const prefix = lines[index][0];
        if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
          throw new Error(`更新文件 ${filePath} 的补丁行必须以空格、+ 或 - 开头。补丁草稿未应用。`);
        }
        current.push(lines[index]);
      }
      index += 1;
    }
    if (current.length > 0) hunks.push({ anchor: currentAnchor, lines: current });
    if (hunks.length === 0 && !moveTo) throw new Error(`更新文件 ${filePath} 没有可应用的 hunk。补丁草稿未应用。`);
    operations.push({ hunks, kind, moveTo, path: filePath });
  }
  throw new Error("apply_patch 缺少 *** End Patch。补丁草稿未应用。");
}

export function pathsFromApplyPatch(patch: string): string[] {
  return [...new Set(parseApplyPatch(patch).flatMap((operation) => operation.kind === "update" && operation.moveTo
    ? [operation.path, operation.moveTo]
    : [operation.path]))];
}
