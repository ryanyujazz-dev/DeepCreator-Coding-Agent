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

test("keeps HTTP transport behind application ports", () => {
  const transport = sourceOf(filesBelow("server/transport"));
  assert.doesNotMatch(transport, /(?:from|import\()\s*["'][^"']*\/infra\//);
  assert.doesNotMatch(transport, /["']node:(?:fs|path|os|child_process)["']/);
  assert.doesNotMatch(transport, /\b(?:RuntimeRepo|RuntimeStore|CommandManager)\b/);
});

test("keeps persistence capabilities split into explicit application ports", () => {
  const ports = readFileSync(path.join(root, "server/app/runtimeRepo.ts"), "utf8");
  for (const name of ["SessionPort", "EventPort", "ContextPort", "EvidencePort", "MemoryPort", "MetricPort"]) {
    assert.match(ports, new RegExp(`export interface ${name}\\b`));
  }
  assert.doesNotMatch(ports, /export interface RuntimeRepo\b/);
  const app = sourceOf(filesBelow("server/app"));
  assert.doesNotMatch(app, /\bRuntimeRepo\b/);
});

test("keeps tool infrastructure split by capability", () => {
  for (const file of ["files.ts", "security.ts", "shellExecution.ts", "summaries.ts"]) {
    assert.equal(statSync(path.join(root, "server/infra/tools", file)).isFile(), true);
  }
  const facade = readFileSync(path.join(root, "server/infra/tools.ts"), "utf8");
  assert.doesNotMatch(facade, /from ["']node:child_process["']/);
  assert.doesNotMatch(facade, /function redactSensitiveText\b|function runShell\b/);
});

test("keeps frontend entry, features, and shared UI in explicit layers", () => {
  for (const directory of ["src/app", "src/features", "src/shared-ui"]) {
    assert.equal(statSync(path.join(root, directory)).isDirectory(), true);
  }
  const main = readFileSync(path.join(root, "src/main.tsx"), "utf8");
  assert.match(main, /from ["']\.\/app\/index["']/);
  const sharedUi = sourceOf(filesBelow("src/shared-ui"));
  assert.doesNotMatch(sharedUi, /(?:from|import\()\s*["'][^"']*(?:\/features\/|\/app\/)/);
  const workspace = readFileSync(path.join(root, "src/useWorkspace.ts"), "utf8");
  assert.match(workspace, /SessionEventStore/);
  assert.doesNotMatch(workspace, /reduceEvents\(/);
});

test("keeps contracts serializable and domain modules platform-neutral", () => {
  const contracts = sourceOf(filesBelow("shared/contracts"));
  const domains = sourceOf([
    ...filesBelow("server/domain"),
    ...filesBelow("shared/domain")
  ]);
  assert.doesNotMatch(contracts, /["']node:/);
  assert.doesNotMatch(contracts, /\b(?:process|Buffer)\s*\./);
  assert.doesNotMatch(domains, /["']node:/);
  assert.doesNotMatch(domains, /\bprocess\.env\b/);
});

test("keeps presentation models out of durable contracts", () => {
  const contracts = sourceOf(filesBelow("shared/contracts"));
  assert.doesNotMatch(
    contracts,
    /export type (?:ActivityGroup|ActivityIndicator|ActivitySlot|DetailKind|DetailMode|DetailRow|DisplaySegment|DisplayTimelineEntry|GroupMode|LiveStep|RunTimelineModel|TimelineEntry|ToolAggregate|ToolImportance)\b/
  );
});

test("keeps Event payload handling exhaustive and free from unchecked reducer casts", () => {
  const reducer = readFileSync(path.join(root, "shared/domain/reducer.ts"), "utf8");
  assert.match(reducer, /assertNever\(event\)/);
  assert.doesNotMatch(reducer, /event\.data\s+as\b/);
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
