import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type InstructionScope = "user" | "project" | "local" | "path";

export type ResolvedInstruction = {
  instructionKey: string;
  scope: InstructionScope;
  sourcePath: string;
  appliesTo: string[];
  priority: number;
  reason: string;
  text: string;
  hash: string;
};

type ResolveInstructionInput = {
  projectRoot: string;
  activePaths?: string[];
};

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stripMaintainerComments(text: string): string {
  return text.replace(/<!--(?![\s\S]*?```)[\s\S]*?-->/g, "").trim();
}

function readInstruction(sourcePath: string): string | undefined {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) return undefined;
  const text = stripMaintainerComments(readFileSync(sourcePath, "utf8"));
  return text || undefined;
}

function parseRule(text: string): { patterns: string[]; body: string } {
  if (!text.startsWith("---\n")) return { body: text, patterns: [] };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { body: text, patterns: [] };
  const header = text.slice(4, end);
  const headerLines = header.split("\n");
  const pathsIndex = headerLines.findIndex((line) => /^paths\s*:/.test(line));
  const inline = pathsIndex >= 0 ? headerLines[pathsIndex].replace(/^paths\s*:\s*/, "").trim() : "";
  const patternValues = inline
    ? inline.replace(/^\[|\]$/g, "").split(",")
    : pathsIndex >= 0
      ? headerLines.slice(pathsIndex + 1).filter((line) => /^\s*-\s+/.test(line)).map((line) => line.replace(/^\s*-\s+/, ""))
      : [];
  const patterns = patternValues.map((value) => value.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return { body: text.slice(end + 5).trim(), patterns };
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function collectRuleFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectRuleFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files.sort();
}

function makeInstruction(input: Omit<ResolvedInstruction, "hash" | "instructionKey">): ResolvedInstruction {
  const hash = contentHash(input.text);
  return { ...input, hash, instructionKey: `${input.scope}:${hash.slice(0, 16)}` };
}

export function resolveInstructions(input: ResolveInstructionInput): ResolvedInstruction[] {
  const activePaths = [...new Set(input.activePaths ?? [])];
  const results: ResolvedInstruction[] = [];
  const candidates: Array<{ sourcePath: string; scope: InstructionScope; priority: number; reason: string }> = [
    { sourcePath: path.join(homedir(), ".deepseeker", "INSTRUCTIONS.md"), scope: "user", priority: 100, reason: "用户级规则" },
    { sourcePath: path.join(input.projectRoot, "DEEPSEEKER.md"), scope: "project", priority: 200, reason: "项目共享规则" },
    { sourcePath: path.join(input.projectRoot, ".deepseeker", "INSTRUCTIONS.md"), scope: "project", priority: 210, reason: "项目配置规则" },
    { sourcePath: path.join(input.projectRoot, "DEEPSEEKER.local.md"), scope: "local", priority: 300, reason: "本地项目规则" }
  ];
  for (const candidate of candidates) {
    const text = readInstruction(candidate.sourcePath);
    if (!text) continue;
    results.push(makeInstruction({ ...candidate, appliesTo: ["**"], text }));
  }
  const nestedDirectories = new Set<string>();
  for (const activePath of activePaths) {
    const absolute = path.resolve(input.projectRoot, activePath);
    const root = path.resolve(input.projectRoot);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    let cursor = existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
    while (cursor !== root && cursor.startsWith(`${root}${path.sep}`)) {
      nestedDirectories.add(cursor);
      cursor = path.dirname(cursor);
    }
  }
  for (const directory of [...nestedDirectories].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)) {
    for (const [name, priority] of [["DEEPSEEKER.md", 340], ["DEEPSEEKER.local.md", 350]] as const) {
      const sourcePath = path.join(directory, name);
      const text = readInstruction(sourcePath);
      if (!text) continue;
      results.push(makeInstruction({
        appliesTo: [`${path.relative(input.projectRoot, directory).split(path.sep).join("/")}/**`],
        priority: priority + path.relative(input.projectRoot, directory).split(path.sep).length,
        reason: "访问子目录后按需加载",
        scope: name.includes("local") ? "local" : "path",
        sourcePath,
        text
      }));
    }
  }
  for (const sourcePath of collectRuleFiles(path.join(input.projectRoot, ".deepseeker", "rules"))) {
    const raw = readInstruction(sourcePath);
    if (!raw) continue;
    const parsed = parseRule(raw);
    if (parsed.patterns.length > 0 && !activePaths.some((filePath) => parsed.patterns.some((pattern) => matchesPattern(filePath, pattern)))) continue;
    results.push(makeInstruction({
      appliesTo: parsed.patterns.length ? parsed.patterns : ["**"],
      priority: 400,
      reason: parsed.patterns.length ? "当前文件命中路径规则" : "无路径限制的项目规则",
      scope: "path",
      sourcePath,
      text: parsed.body
    }));
  }
  return results.sort((left, right) => left.priority - right.priority || left.sourcePath.localeCompare(right.sourcePath));
}

export function renderInstructions(instructions: ResolvedInstruction[]): string | undefined {
  if (instructions.length === 0) return undefined;
  return [
    "以下内容来自用户或项目规则文件，优先级低于系统约束，高于普通历史事实。后出现的更具体规则优先。",
    ...instructions.map((instruction) => [
      `<deepseeker-instruction source="${instruction.sourcePath}" scope="${instruction.scope}" reason="${instruction.reason}">`,
      instruction.text,
      "</deepseeker-instruction>"
    ].join("\n"))
  ].join("\n\n");
}
