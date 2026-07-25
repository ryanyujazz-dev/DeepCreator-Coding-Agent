export type DiffModels = {
  modified: string;
  original: string;
  sourceLineCount: number;
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function modelsFromUnifiedPatch(patch: string): DiffModels {
  const original: string[] = [];
  const modified: string[] = [];
  const patchLines = patch.split("\n");
  let insideHunk = false;

  for (const [index, line] of patchLines.entries()) {
    const hunk = line.match(hunkHeaderPattern);
    if (hunk) {
      insideHunk = true;
      const originalStart = Number(hunk[1]);
      const modifiedStart = Number(hunk[2]);
      while (original.length < originalStart - 1) original.push("");
      while (modified.length < modifiedStart - 1) modified.push("");
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (index === patchLines.length - 1 && line === "") continue;
    if (line.startsWith("+")) {
      modified.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      original.push(line.slice(1));
      continue;
    }
    const value = line.startsWith(" ") ? line.slice(1) : line;
    original.push(value);
    modified.push(value);
  }

  return {
    modified: modified.join("\n"),
    original: original.join("\n"),
    sourceLineCount: Math.max(original.length, modified.length)
  };
}
