// 行级 LCS unified diff 生成器。无外部依赖(项目零 diff 库),与 applyPatch 对称。
// 用于 edit_file/multi_edit 返回给模型的改动展示(模型验证 + 迭代)。

const CONTEXT = 3;
const MAX_LINES = 2000;
const MAX_HUNKS = 200;

type Op = { line: string; type: " " | "+" | "-" };

function splitNoTrailing(input: string): string[] {
  if (input.length === 0) return [];
  return input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
}

// LCS 动态规划 → op 序列(空格=相同,-=仅 before,+=仅 after)。
// O(m*n) time/memory;MAX_LINES cap 保证上限。Int32Array 节省内存。
function diffOps(beforeLines: string[], afterLines: string[]): Op[] {
  const m = beforeLines.length;
  const n = afterLines.length;
  if (m === 0) return afterLines.map((line) => ({ line, type: "+" as const }));
  if (n === 0) return beforeLines.map((line) => ({ line, type: "-" as const }));
  const dp: Int32Array[] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ line: beforeLines[i], type: " " });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ line: beforeLines[i], type: "-" });
      i += 1;
    } else {
      ops.push({ line: afterLines[j], type: "+" });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ line: beforeLines[i], type: "-" });
    i += 1;
  }
  while (j < n) {
    ops.push({ line: afterLines[j], type: "+" });
    j += 1;
  }
  return ops;
}

export function generateUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = splitNoTrailing(before);
  const afterLines = splitNoTrailing(after);
  if (beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES) {
    return `(${filePath} 过大,已省略 diff)`;
  }
  const ops = diffOps(beforeLines, afterLines);

  // 找所有变更 op index
  const changed: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== " ") changed.push(index);
  }
  if (changed.length === 0) return "";

  // 分组 hunks:间隔 > 2*CONTEXT 开新 hunk
  const hunks: Array<{ start: number; end: number }> = [];
  let groupStart = Math.max(0, changed[0] - CONTEXT);
  let groupEnd = Math.min(ops.length - 1, changed[0] + CONTEXT);
  for (let k = 1; k < changed.length; k += 1) {
    const c = changed[k];
    if (c - CONTEXT <= groupEnd) {
      groupEnd = Math.min(ops.length - 1, c + CONTEXT);
    } else {
      hunks.push({ start: groupStart, end: groupEnd });
      groupStart = Math.max(0, c - CONTEXT);
      groupEnd = Math.min(ops.length - 1, c + CONTEXT);
    }
  }
  hunks.push({ start: groupStart, end: groupEnd });

  if (hunks.length > MAX_HUNKS) {
    return formatHunks(hunks.slice(0, MAX_HUNKS), ops, filePath) + "\n... diff 已截断 ...";
  }
  return formatHunks(hunks, ops, filePath);
}

function formatHunks(hunks: Array<{ start: number; end: number }>, ops: Op[], filePath: string): string {
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  // 每个 op 的 before/after 行号(1-indexed)
  const beforeLineOf: number[] = [];
  const afterLineOf: number[] = [];
  let b = 1;
  let a = 1;
  for (const op of ops) {
    beforeLineOf.push(b);
    afterLineOf.push(a);
    if (op.type === " ") {
      b += 1;
      a += 1;
    } else if (op.type === "-") {
      b += 1;
    } else {
      a += 1;
    }
  }
  for (const hunk of hunks) {
    const bStart = beforeLineOf[hunk.start] ?? 1;
    const aStart = afterLineOf[hunk.start] ?? 1;
    let bCount = 0;
    let aCount = 0;
    const body: string[] = [];
    for (let index = hunk.start; index <= hunk.end && index < ops.length; index += 1) {
      const op = ops[index];
      body.push(`${op.type}${op.line}`);
      if (op.type === " " || op.type === "-") bCount += 1;
      if (op.type === " " || op.type === "+") aCount += 1;
    }
    lines.push(`@@ -${bStart},${bCount} +${aStart},${aCount} @@`);
    lines.push(...body);
  }
  return lines.join("\n");
}
