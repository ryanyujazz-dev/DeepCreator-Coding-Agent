import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_NAMES = new Set(["assets", "references", "scripts"]);

function fail(message) {
  throw new Error(message);
}

function inside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function titleCase(name) {
  return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const args = process.argv.slice(2);
const description = option(args, "--description");
const displayName = option(args, "--display-name");
const outputParent = option(args, "--path") ?? ".";
const publisher = option(args, "--publisher");
const resourcesValue = option(args, "--resources") ?? "";
if (args.some((arg) => arg.startsWith("--"))) fail(`Unknown option: ${args.find((arg) => arg.startsWith("--"))}`);
if (args.length !== 1) fail("Usage: init-skill.mjs <name> --description <text> --publisher <name> [--display-name <label>] [--path <relative-directory>] [--resources references,scripts,assets]");

const name = args[0];
if (!NAME_PATTERN.test(name) || name.length > 64) fail("Skill name must use lowercase hyphen-case and be at most 64 characters.");
if (!description?.trim()) fail("--description is required and must explain what the Skill does and when to use it.");
if (description.trim().length > 240) fail("--description must be at most 240 characters.");
if (!publisher?.trim()) fail("--publisher is required.");

const resources = resourcesValue.split(",").map((item) => item.trim()).filter(Boolean);
const invalidResource = resources.find((resource) => !RESOURCE_NAMES.has(resource));
if (invalidResource) fail(`Unsupported resource directory: ${invalidResource}`);

const workspace = path.resolve(process.cwd());
const parent = path.resolve(workspace, outputParent);
const root = path.join(parent, name);
if (!inside(workspace, root)) fail("Skill output must stay inside the current workspace.");
if (existsSync(root)) fail(`Skill directory already exists: ${path.relative(workspace, root)}`);

const resolvedDisplayName = displayName?.trim() || titleCase(name);
mkdirSync(path.join(root, "agents"), { recursive: true });
for (const resource of new Set(resources)) mkdirSync(path.join(root, resource), { recursive: true });

const scriptGuidance = resources.includes("scripts")
  ? "\n## Declared scripts\n\n<!-- TODO: Declare each .mjs script in skill.json, then tell the Agent to call `run_skill_script` with this Skill's loaded capabilityId and the exact scriptId. Never instruct it to run package-local scripts by relative shell path. -->\n"
  : "";
writeFileSync(path.join(root, "SKILL.md"), [
  "---",
  `name: ${name}`,
  `description: ${JSON.stringify(description.trim())}`,
  "---",
  "",
  `# ${resolvedDisplayName}`,
  "",
  "<!-- TODO: Replace this marker with concise, imperative workflow instructions before validation. -->",
  "",
  "Describe only the non-obvious procedure another Agent needs to follow. Move detailed material into references/ and reusable output files into assets/.",
  scriptGuidance.trimEnd(),
  ""
].filter((line, index, values) => line || values[index - 1] !== "").join("\n"));

writeFileSync(path.join(root, "skill.json"), `${JSON.stringify({
  schemaVersion: 1,
  displayName: resolvedDisplayName,
  version: "1.0.0",
  publisher: publisher.trim(),
  minDeepCreatorVersion: "0.1.0",
  permissions: ["workspace_read"]
}, null, 2)}\n`);

writeFileSync(path.join(root, "agents", "openai.yaml"), [
  "interface:",
  `  display_name: ${JSON.stringify(resolvedDisplayName)}`,
  `  short_description: ${JSON.stringify(`Use ${resolvedDisplayName} workflows in DeepCreator`.slice(0, 64))}`,
  `  default_prompt: ${JSON.stringify(`Use $${name} to complete this workflow.`)}`,
  ""
].join("\n"));

process.stdout.write([
  `Created ${path.relative(workspace, root).replaceAll("\\", "/")}`,
  "Next: replace every TODO, add only necessary resources, declare minimal permissions, then run the validate script."
].join("\n") + "\n");
