import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function filesBelow(relativeDirectory: string): string[] {
  const directory = path.join(root, relativeDirectory);
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return filesBelow(path.relative(root, absolute));
    return absolute.endsWith(".ts") || absolute.endsWith(".tsx") ? [absolute] : [];
  });
}

function sourceOf(files: string[]): string {
  return files.map((file) => `${path.relative(root, file)}\n${readFileSync(file, "utf8")}`).join("\n");
}

test("keeps application and domain code independent from infrastructure", () => {
  const files = [
    ...filesBelow("server/app"),
    ...filesBelow("server/domain"),
    ...filesBelow("shared/contracts"),
    ...filesBelow("shared/domain"),
    ...filesBelow("shared/projections")
  ];
  const source = sourceOf(files);
  assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*\/infra\//);
  assert.doesNotMatch(source, /["']node:(?:fs|os|child_process)["']/);
  assert.doesNotMatch(source, /\bprocess\.env\b/);
});

test("keeps V1 vocabulary inside explicit compatibility boundaries", () => {
  const files = [
    ...filesBelow("server/app"),
    ...filesBelow("server/domain"),
    ...filesBelow("server/transport"),
    ...filesBelow("shared/contracts"),
    ...filesBelow("shared/domain"),
    ...filesBelow("shared/projections"),
    ...filesBelow("src")
  ];
  const source = sourceOf(files);
  assert.doesNotMatch(source, /\b(?:WorkspaceSession|WorkCycle|ActivityUnit|AgentSignal|CycleView|SignalStore)\b/);
  assert.doesNotMatch(source, /\b(?:sessionKey|cycleKey|unitKey|signalKey)\b/);
  assert.doesNotMatch(source, /\b(?:operationClass|resourceKind|effectKind|aggregationPolicy|detailPolicy)\b/);
});
