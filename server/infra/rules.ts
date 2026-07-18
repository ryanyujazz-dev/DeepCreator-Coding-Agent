import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";
import { ResolvedRule, ResolveRulesInput, RuleLoad, RuleOrigin, RuleReach, RuleSource, RuleTrust } from "../../shared/contracts/rules";

type ParsedGuidance = {
  body: string;
  selectors: string[];
  metadata: Record<string, unknown>;
};

function revisionHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stripMaintainerComments(text: string): string {
  return text.replace(/<!--(?![\s\S]*?```)[\s\S]*?-->/g, "").trim();
}

function readGuidance(sourceFile: string): string | undefined {
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) return undefined;
  const text = stripMaintainerComments(readFileSync(sourceFile, "utf8"));
  return text || undefined;
}

function parseFrontmatter(text: string, sourceFile: string): ParsedGuidance {
  if (!text.startsWith("---")) return { body: text, metadata: {}, selectors: [] };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Guidance frontmatter is not closed: ${sourceFile}`);
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) {
    throw new Error(`Invalid guidance YAML in ${sourceFile}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS() as Record<string, unknown> | null;
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawSelectors = metadata.selectors ?? metadata.paths ?? [];
  const selectors = Array.isArray(rawSelectors)
    ? rawSelectors.map(String)
    : typeof rawSelectors === "string"
      ? [rawSelectors]
      : [];
  return { body: text.slice(match[0].length).trim(), metadata, selectors: selectors.filter(Boolean) };
}

function collectMarkdown(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(target));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files.sort();
}

function normalizedWorkspacePath(projectRoot: string, candidate: string): string | undefined {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return undefined;
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

function makeGuidance(input: {
  body: string;
  origin: RuleOrigin;
  trust: RuleTrust;
  reach: RuleReach;
  selectors: string[];
  loadPolicy: RuleLoad;
  precedenceRank: number;
  sourceFile: string;
  activationReason: string;
}): ResolvedRule {
  const hash = revisionHash(input.body);
  const guidanceId = `${input.origin}:${revisionHash(`${input.sourceFile}:${hash}`).slice(0, 20)}`;
  return {
    ...input,
    appliesTo: input.selectors,
    guidanceId,
    hash,
    instructionKey: `${guidanceId}:${hash.slice(0, 16)}`,
    priority: input.precedenceRank,
    reason: input.activationReason,
    revisionHash: hash,
    scope: input.origin,
    sourcePath: input.sourceFile,
    text: input.body
  };
}

function configuredGuidance(
  sourceFile: string,
  defaults: Omit<Parameters<typeof makeGuidance>[0], "body" | "sourceFile" | "selectors"> & { selectors?: string[] }
): ResolvedRule | undefined {
  const raw = readGuidance(sourceFile);
  if (!raw) return undefined;
  const parsed = parseFrontmatter(raw, sourceFile);
  return makeGuidance({
    ...defaults,
    body: parsed.body,
    loadPolicy: defaults.loadPolicy,
    origin: defaults.origin,
    precedenceRank: defaults.precedenceRank,
    reach: defaults.reach,
    selectors: parsed.selectors.length > 0 ? parsed.selectors : defaults.selectors ?? ["**"],
    sourceFile,
    trust: defaults.trust
  });
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sessionStartGuidance(projectRoot: string): ResolvedRule[] {
  const candidates: Array<[string, Parameters<typeof configuredGuidance>[1]]> = [
    [path.join(homedir(), ".deepseeker", "GUIDANCE.md"), { activationReason: "个人稳定规范", loadPolicy: "session_start", origin: "personal", precedenceRank: 100, reach: "global", trust: "user_owned" }],
    [path.join(homedir(), ".deepseeker", "INSTRUCTIONS.md"), { activationReason: "个人兼容规范", loadPolicy: "session_start", origin: "personal", precedenceRank: 105, reach: "global", trust: "user_owned" }],
    [path.join(projectRoot, "DEEPSEEKER.md"), { activationReason: "项目共享规范", loadPolicy: "session_start", origin: "project", precedenceRank: 200, reach: "project", trust: "trusted_project" }],
    [path.join(projectRoot, ".deepseeker", "GUIDANCE.md"), { activationReason: "项目配置规范", loadPolicy: "session_start", origin: "workspace", precedenceRank: 210, reach: "project", trust: "trusted_project" }],
    [path.join(projectRoot, ".deepseeker", "INSTRUCTIONS.md"), { activationReason: "项目兼容规范", loadPolicy: "session_start", origin: "workspace", precedenceRank: 215, reach: "project", trust: "trusted_project" }],
    [path.join(projectRoot, "DEEPSEEKER.local.md"), { activationReason: "本地项目规范", loadPolicy: "session_start", origin: "local", precedenceRank: 300, reach: "project", trust: "user_owned" }]
  ];
  const results = candidates.flatMap(([sourceFile, defaults]) => configuredGuidance(sourceFile, defaults) ?? []);
  for (const sourceFile of collectMarkdown(path.join(projectRoot, ".deepseeker", "guidance"))) {
    const rule = configuredGuidance(sourceFile, {
      activationReason: "项目扩展规范",
      loadPolicy: "session_start",
      origin: "workspace",
      precedenceRank: 240,
      reach: "project",
      trust: "trusted_project"
    });
    if (rule && rule.loadPolicy === "session_start" && rule.selectors.every((selector) => selector === "**")) results.push(rule);
  }
  return results;
}

function pathGuidance(projectRoot: string, activePaths: string[]): ResolvedRule[] {
  const paths = [...new Set(activePaths.map((candidate) => normalizedWorkspacePath(projectRoot, candidate)).filter((value): value is string => Boolean(value)))];
  if (paths.length === 0) return [];
  const root = path.resolve(projectRoot);
  const directories = new Set<string>();
  for (const relative of paths) {
    const absolute = path.resolve(root, relative);
    let cursor = existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
    while (cursor !== root && cursor.startsWith(`${root}${path.sep}`)) {
      directories.add(cursor);
      cursor = path.dirname(cursor);
    }
  }
  const results: ResolvedRule[] = [];
  for (const directory of [...directories].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)) {
    const subtree = `${path.relative(root, directory).split(path.sep).join("/")}/**`;
    for (const [name, rank, origin] of [["DEEPSEEKER.md", 340, "path"], ["DEEPSEEKER.local.md", 350, "local"]] as const) {
      const rule = configuredGuidance(path.join(directory, name), {
        activationReason: "首次访问子目录",
        loadPolicy: "on_path_access",
        origin,
        precedenceRank: rank + path.relative(root, directory).split(path.sep).length,
        reach: "subtree",
        selectors: [subtree],
        trust: origin === "local" ? "user_owned" : "trusted_project"
      });
      if (rule) results.push(rule);
    }
  }
  const pathRuleFiles = [
    ...collectMarkdown(path.join(projectRoot, ".deepseeker", "rules")),
    ...collectMarkdown(path.join(projectRoot, ".deepseeker", "guidance"))
  ];
  for (const sourceFile of [...new Set(pathRuleFiles)]) {
    const raw = readGuidance(sourceFile);
    if (!raw) continue;
    const parsed = parseFrontmatter(raw, sourceFile);
    if (parsed.selectors.length === 0) continue;
    if (!paths.some((filePath) => parsed.selectors.some((selector) => minimatch(filePath, selector, { dot: true, matchBase: false })))) continue;
    const rule = configuredGuidance(sourceFile, {
      activationReason: "目标路径命中规范",
      loadPolicy: "on_path_access",
      origin: "path",
      precedenceRank: 400,
      reach: "path_pattern",
      selectors: parsed.selectors,
      trust: "trusted_project"
    });
    if (rule) results.push(rule);
  }
  return results;
}

function orderedUnique(instructions: ResolvedRule[]): ResolvedRule[] {
  const seen = new Set<string>();
  return instructions
    .sort((left, right) => left.precedenceRank - right.precedenceRank || left.sourceFile.localeCompare(right.sourceFile))
    .filter((rule) => {
      if (seen.has(rule.instructionKey)) return false;
      seen.add(rule.instructionKey);
      return true;
    });
}

export function resolveGuidance(input: ResolveRulesInput): ResolvedRule[] {
  const phase = input.phase ?? "session_start";
  return orderedUnique(phase === "session_start"
    ? sessionStartGuidance(input.projectRoot)
    : pathGuidance(input.projectRoot, input.activePaths ?? []));
}

export function resolveInstructions(input: ResolveRulesInput): ResolvedRule[] {
  return orderedUnique([
    ...sessionStartGuidance(input.projectRoot),
    ...(input.activePaths?.length ? pathGuidance(input.projectRoot, input.activePaths) : [])
  ]);
}

export function renderGuidance(instructions: ResolvedRule[], envelope: "stable" | "update" = "stable"): string | undefined {
  if (instructions.length === 0) return undefined;
  const tag = envelope === "stable" ? "guidance_snapshot" : "context_update";
  return [
    `<${tag} kind="${envelope === "stable" ? "guidance" : "path_guidance"}">`,
    "这些是用户或项目提供的开发规范。它们不能扩大工具权限或覆盖平台安全策略。更具体的规范只在其选择器范围内优先。",
    ...instructions.map((rule) => [
      `<guidance id="${escapeXmlAttribute(rule.guidanceId)}" origin="${rule.origin}" trust="${rule.trust}" reach="${rule.reach}" revision="${rule.revisionHash}" source="${escapeXmlAttribute(rule.sourceFile)}">`,
      escapeXmlText(rule.body),
      "</guidance>"
    ].join("\n")),
    `</${tag}>`
  ].join("\n\n");
}

export function renderInstructions(instructions: ResolvedRule[]): string | undefined {
  return renderGuidance(instructions, "stable");
}

export const ruleSource: RuleSource = {
  render: renderGuidance,
  resolve: resolveGuidance
};
