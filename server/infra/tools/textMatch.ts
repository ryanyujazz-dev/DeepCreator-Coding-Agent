// edit_file / multi_edit 的容错匹配原语。从 applyPatch.ts 的 sameLines/matchingLines 提炼,
// 增加 window(行号锚定用)+ splitLines/joinLines(trailingNewline 处理)。
//
// 匹配策略:strict(精确 ===)→ relaxed(trimEnd 尾随空白容错)。strict 永不降级(精确命中走原路径,
// 完全向后兼容);strict=0 才降级 relaxed;relaxed 多匹配不猜(报错);relaxed 唯一才替换整行。

function sameLines(left: string[], right: string[], start: number, relaxed: boolean): boolean {
  if (start + left.length > right.length) return false;
  return left.every((line, offset) => relaxed
    ? line.trimEnd() === right[start + offset].trimEnd()
    : line === right[start + offset]);
}

function matchingLines(source: string[], pattern: string[], from: number, relaxed: boolean, to?: number): number[] {
  const upper = to !== undefined ? Math.min(to, source.length - pattern.length) : source.length - pattern.length;
  const matches: number[] = [];
  for (let index = Math.max(0, from); index <= upper; index += 1) {
    if (sameLines(pattern, source, index, relaxed)) matches.push(index);
  }
  return matches;
}

export type LocateResult = {
  /** strict(精确)命中的起始行索引(0-indexed)。 */
  strict: number[];
  /** relaxed(trimEnd)命中的起始行索引(0-indexed)。 */
  relaxed: number[];
};

/**
 * 在 source 行数组里找 pattern 行数组的所有匹配起点。window 限定搜索范围(0-indexed inclusive)。
 * 返回 strict + relaxed 两组(不短路 —— 调用方需判断「strict 0 但 relaxed 多」等信号)。
 */
export function locateLineMatches(
  source: string[],
  pattern: string[],
  window?: { from: number; to: number }
): LocateResult {
  const from = window?.from ?? 0;
  const to = window?.to;
  return {
    strict: matchingLines(source, pattern, from, false, to),
    relaxed: matchingLines(source, pattern, from, true, to)
  };
}

/** 把 contents 按行切(\r\n → \n)。trailingNewline=true 时末尾换行不产生空行元素。 */
export function splitLines(contents: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = contents.endsWith("\n");
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * 找 oldText 第一行在 source 里 trimEnd 最近似的行(用于「未找到」报错的上下文提示)。
 * 返回行号(0-indexed)或 -1。
 */
export function nearestLine(source: string[], oldText: string): number {
  const firstLine = oldText.split("\n")[0]?.trimEnd();
  if (!firstLine) return -1;
  let best = -1;
  let bestScore = 0;
  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index].trimEnd();
    if (candidate === firstLine) return index;
    // 简单包含 + 长度相似度,找次优
    if (candidate.includes(firstLine) || firstLine.includes(candidate)) {
      const score = Math.min(firstLine.length, candidate.length);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
  }
  return best;
}
