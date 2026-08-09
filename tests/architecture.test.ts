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

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

test("typechecks shared, server, auth, renderer, desktop, evals, tooling, and tests as separate projects", () => {
  const solution = JSON.parse(readFileSync(path.join(root, "tsconfig.json"), "utf8")) as {
    files?: string[];
    references?: Array<{ path: string }>;
  };
  assert.deepEqual(solution.files, []);
  assert.deepEqual(
    solution.references?.map((reference) => reference.path),
    [
      "./tsconfig.shared.json",
      "./tsconfig.server.json",
      "./tsconfig.auth.json",
      "./tsconfig.renderer.json",
      "./tsconfig.desktop.json",
      "./tsconfig.evals.json",
      "./tsconfig.tooling.json",
      "./tsconfig.tests.json"
    ]
  );

  const shared = JSON.parse(readFileSync(path.join(root, "tsconfig.shared.json"), "utf8"));
  const server = JSON.parse(readFileSync(path.join(root, "tsconfig.server.json"), "utf8"));
  const renderer = JSON.parse(readFileSync(path.join(root, "tsconfig.renderer.json"), "utf8"));
  assert.deepEqual(shared.compilerOptions.types, []);
  assert.deepEqual(server.compilerOptions.types, ["node"]);
  assert.ok(!server.compilerOptions.lib.includes("DOM"));
  assert.deepEqual(renderer.compilerOptions.types, ["vite/client"]);
  assert.ok(!renderer.compilerOptions.types.includes("node"));
});

test("keeps application code independent from Node platform globals", () => {
  const app = sourceOf(filesBelow("server/app"));
  assert.doesNotMatch(app, /["']node:/);
  assert.doesNotMatch(app, /\b(?:process|Buffer)\s*\./);
  assert.doesNotMatch(app, /(?:new Date\(|Date\.now\()/);
});

test("keeps reusable runtime composition free from host configuration reads", () => {
  const runtime = readFileSync(path.join(root, "server/bootstrap/runtime.ts"), "utf8");
  const entry = readFileSync(path.join(root, "server/bootstrap/main.ts"), "utf8");
  assert.doesNotMatch(runtime, /loadUserConfig|process\.env|dotenv/);
  assert.match(entry, /loadUserConfig\(\)/);
  assert.doesNotMatch(entry, /dotenv|\.env\.local/);
});

test("injects time and identity into the execution chain", () => {
  const execution = sourceOf([
    path.join(root, "server/app/runRegistry.ts"),
    path.join(root, "server/app/runner.ts"),
    path.join(root, "server/app/delegationCoordinator.ts"),
    path.join(root, "server/app/toolPipeline.ts")
  ]);
  assert.doesNotMatch(execution, /["']node:crypto["']/);
  assert.doesNotMatch(execution, /(?:new Date\(\)|Date\.now\(\))/);
  assert.match(execution, /SystemPort|registry\.system/);
});

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

test("validates Runtime wire data and maps typed application errors", () => {
  const client = readFileSync(path.join(root, "src/runtimeApi.ts"), "utf8");
  const transport = readFileSync(path.join(root, "server/transport/http.ts"), "utf8");
  const schemas = readFileSync(path.join(root, "shared/schemas/http.ts"), "utf8");
  assert.match(client, /decodeEventStream\(JSON\.parse\(data\)\)/);
  assert.doesNotMatch(client, /response\.json\(\)\s+as\b/);
  assert.match(transport, /error instanceof AppError/);
  assert.doesNotMatch(transport, /\/(?:not found|stale|not waiting)\/i/);
  for (const name of [
    "fileQuerySchema",
    "memoryInputSchema",
    "planResolveInputSchema",
    "planRevisionInputSchema",
    "projectArchiveInputSchema",
    "questionAnswerInputSchema",
    "sessionListQuerySchema",
    "sidebarInputSchema"
  ]) {
    assert.match(schemas, new RegExp(`export const ${name}\\b`));
    assert.match(transport, new RegExp(`schema: ${name}\\b`));
  }
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
  for (const file of ["changes.ts", "files.ts", "managedCommands.ts", "registry.ts", "search.ts", "security.ts", "shellExecution.ts", "skills.ts", "summaries.ts", "web.ts"]) {
    assert.equal(statSync(path.join(root, "server/infra/tools", file)).isFile(), true);
  }
  const facade = readFileSync(path.join(root, "server/infra/tools.ts"), "utf8");
  assert.ok(facade.split("\n").length <= 320, "tool facade accumulated capability implementation details");
  assert.doesNotMatch(facade, /from ["']node:child_process["']/);
  assert.doesNotMatch(facade, /function (?:collectChanges|fetchUrl|globFiles|grepFiles|redactSensitiveText|runShell)\b/);
});

test("keeps frontend entry, features, and shared UI in explicit layers", () => {
  for (const directory of ["src/app", "src/features", "src/platform", "src/shared-ui"]) {
    assert.equal(statSync(path.join(root, directory)).isDirectory(), true);
  }
  const main = readFileSync(path.join(root, "src/main.tsx"), "utf8");
  assert.match(main, /from ["']\.\/app\/index["']/);
  const sharedUi = sourceOf(filesBelow("src/shared-ui"));
  assert.doesNotMatch(sharedUi, /(?:from|import\()\s*["'][^"']*(?:\/features\/|\/app\/)/);
  const workspace = readFileSync(path.join(root, "src/useWorkspace.ts"), "utf8");
  assert.match(workspace, /SessionEventStore/);
  assert.match(workspace, /useRuntimeObservers/);
  assert.ok(workspace.split("\n").length <= 400, "workspace orchestration accumulated observer implementation details");
  assert.doesNotMatch(workspace, /reduceEvents\(/);
});

test("routes renderer host capabilities through the platform boundary", () => {
  const rendererFiles = filesBelow("src").filter((file) => !file.includes(`${path.sep}platform${path.sep}`));
  const renderer = sourceOf(rendererFiles);
  assert.doesNotMatch(renderer, /window\.deepcreator/);
  assert.doesNotMatch(renderer, /window\.localStorage/);
  const desktop = readFileSync(path.join(root, "src/platform/desktop.ts"), "utf8");
  assert.match(desktop, /window\.deepcreator/);
});

test("keeps heavyweight renderer capabilities behind lazy boundaries", () => {
  const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
  const activities = readFileSync(path.join(root, "src/components/ActivityGroupRenderer.tsx"), "utf8");
  const markdown = readFileSync(path.join(root, "src/components/MarkdownContent.tsx"), "utf8");
  assert.match(app, /lazy\(\(\) => import\(["']\.\/components\/SurfacePane["']\)/);
  assert.match(activities, /lazy\(\(\) => import\(["']\.\/CodeEditorSurface["']\)/);
  assert.match(markdown, /lazy\(\(\) => import\(["']\.\/MermaidBlock["']\)/);
});

test("resolves the lazy Lottie adapter to a React component", async () => {
  const module = await import("../src/shared-ui/LottiePlayer");
  assert.equal(typeof module.default, "function");
});

test("isolates legacy CSS and requires semantic colors in new style modules", () => {
  const main = readFileSync(path.join(root, "src/main.tsx"), "utf8");
  const entry = readFileSync(path.join(root, "src/styles/index.css"), "utf8");
  const legacy = readFileSync(path.join(root, "src/styles.css"), "utf8");
  const surfaces = readFileSync(path.join(root, "src/styles/features/application-surfaces.css"), "utf8");
  const stylelint = readFileSync(path.join(root, "stylelint.config.mjs"), "utf8");
  assert.match(main, /import ["']\.\/styles\/index\.css["']/);
  assert.match(entry, /@import ["']\.\.\/styles\.css["']/);
  assert.match(entry, /@import ["']\.\/features\/application-surfaces\.css["']/);
  assert.match(surfaces, /Workspace canvases share one soft, elevated boundary/);
  assert.ok(legacy.split("\n").length <= 9_620, "legacy stylesheet grew instead of moving toward feature modules");
  assert.ok(countMatches(legacy, /#[\da-fA-F]{3,8}|rgba?\(/g) <= 628, "legacy stylesheet added another hard-coded color");
  assert.match(stylelint, /["']color-no-hex["']:\s*true/);
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
