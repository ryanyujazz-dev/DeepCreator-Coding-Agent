import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PERMISSIONS = new Set([
  "workspace_read", "workspace_write", "workspace_delete", "shell_execute",
  "network_access", "external_access", "local_code_execution"
]);
const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function inside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function parseFrontmatter(source) {
  const raw = readFileSync(source, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail("SKILL.md must begin with YAML frontmatter.");
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
    if (!field) fail(`Unsupported frontmatter syntax: ${line}`);
    const value = field[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_all, double, single) => double ?? single);
    metadata[field[1]] = value;
  }
  const keys = Object.keys(metadata);
  if (keys.some((key) => key !== "name" && key !== "description")) fail("SKILL.md frontmatter only allows name and description.");
  if (!NAME.test(metadata.name ?? "")) fail("Skill name must use lowercase hyphen-case.");
  if (!metadata.description) fail("Skill description is required.");
  if (metadata.description.length > 240) fail("Skill description must be at most 240 characters.");
  const body = raw.slice(match[0].length).trim();
  if (!body) fail("SKILL.md body is required.");
  if (/<!--\s*TODO\b/i.test(raw)) fail("Skill contains unfinished template placeholders.");
  return { body, metadata };
}

function validatePermissions(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !PERMISSIONS.has(item))) {
    fail(`${label} contains invalid permissions.`);
  }
  return new Set(value);
}

function collect(root) {
  const files = [];
  let bytes = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isSymbolicLink() || lstatSync(target).isSymbolicLink()) fail(`Symbolic links are not allowed: ${relative}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        bytes += statSync(target).size;
        files.push(relative);
      } else fail(`Unsupported file type: ${relative}`);
    }
  };
  visit(root);
  if (files.length > MAX_FILES) fail(`Skill contains more than ${MAX_FILES} files.`);
  if (bytes > MAX_BYTES) fail("Skill expands beyond 50 MiB.");
  return files;
}

export function validateSkill(input) {
  const workspace = path.resolve(process.cwd());
  const root = path.resolve(workspace, input);
  if (!inside(workspace, root)) fail("Skill directory must be inside the current workspace.");
  if (!existsSync(root) || !statSync(root).isDirectory()) fail("Skill directory does not exist.");
  const parsed = parseFrontmatter(path.join(root, "SKILL.md"));
  const { body, metadata } = parsed;
  if (path.basename(root) !== metadata.name) fail("Skill directory name must match SKILL.md name.");
  const manifestPath = path.join(root, "skill.json");
  if (!existsSync(manifestPath)) fail("skill.json is required.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const allowed = new Set(["schemaVersion", "displayName", "version", "publisher", "minDeepCreatorVersion", "permissions", "scripts"]);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("skill.json must be an object.");
  if (Object.keys(manifest).some((key) => !allowed.has(key))) fail("skill.json contains unsupported fields.");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
  for (const key of ["displayName", "publisher"]) if (typeof manifest[key] !== "string" || !manifest[key].trim()) fail(`${key} is required.`);
  if (/^(?:your name|example publisher|example skill)$/i.test(manifest.publisher.trim()) || /^example skill$/i.test(manifest.displayName.trim())) {
    fail("skill.json contains unfinished template placeholders.");
  }
  for (const key of ["version", "minDeepCreatorVersion"]) if (!SEMVER.test(manifest[key] ?? "")) fail(`${key} must be SemVer.`);
  const packagePermissions = validatePermissions(manifest.permissions, "skill.json");
  const declaredScripts = Object.entries(manifest.scripts ?? {});
  for (const [id, script] of declaredScripts) {
    if (!NAME.test(id) || !script || typeof script !== "object" || Array.isArray(script)) fail(`Invalid script: ${id}`);
    if (Object.keys(script).some((key) => !["entry", "description", "permissions"].includes(key))) fail(`Script ${id} contains unsupported fields.`);
    if (typeof script.entry !== "string" || !script.entry.startsWith("scripts/") || !script.entry.endsWith(".mjs")) fail(`Invalid script entry: ${id}`);
    const target = path.resolve(root, script.entry);
    if (!inside(path.join(root, "scripts"), target) || !existsSync(target) || !statSync(target).isFile()) fail(`Missing script entry: ${script.entry}`);
    if (typeof script.description !== "string" || !script.description.trim()) fail(`Script ${id} needs a description.`);
    const permissions = validatePermissions(script.permissions, `Script ${id}`);
    if (!permissions.has("local_code_execution")) fail(`Script ${id} must declare local_code_execution.`);
    for (const permission of permissions) if (!packagePermissions.has(permission)) fail(`Script ${id} exceeds package permission ${permission}.`);
  }
  if (declaredScripts.length > 0) {
    if (!body.includes("run_skill_script")) fail("Skills with declared scripts must instruct the Agent to use run_skill_script.");
    for (const [id] of declaredScripts) {
      if (!body.includes(id)) fail(`SKILL.md must identify the declared scriptId: ${id}`);
    }
    const directInvocation = body.split(/\r?\n/).find((line) =>
      /(?:node|bun|deno)\s+(?:\.\/)?scripts[\\/]/i.test(line)
      && !/(?:never|do not|must not|不得|不要|禁止)/i.test(line)
    );
    if (directInvocation) fail("Do not invoke package-local scripts by shell path; use run_skill_script with capabilityId and scriptId.");
  }
  const files = collect(root);
  return { files, manifest, metadata, root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = validateSkill(process.argv[2] ?? ".");
  process.stdout.write(`Valid DeepCreator Skill: ${result.metadata.name} (${result.manifest.version}), ${result.files.length} files.\n`);
}
