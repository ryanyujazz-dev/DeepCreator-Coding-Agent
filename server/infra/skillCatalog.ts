import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  SkillManifest,
  SkillOrigin,
  SkillPermission,
  SkillScriptManifest,
  SkillSummary
} from "../../shared/contracts/skill";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PERMISSIONS = new Set<SkillPermission>([
  "workspace_read",
  "workspace_write",
  "workspace_delete",
  "shell_execute",
  "network_access",
  "external_access",
  "local_code_execution"
]);

export type SkillRegistryRecord = {
  disabled?: string[];
  installs?: Record<string, {
    availableVersion?: string;
    checkedAt?: string;
    releaseUrl?: string;
    repository?: string;
    revisionHash: string;
    sourceKind: "github" | "local";
    trusted: boolean;
    updateState?: "current" | "available" | "failed" | "unsupported";
  }>;
};

export type LoadedSkill = SkillSummary & {
  body: string;
  directory: string;
  manifest?: SkillManifest;
};

export type SkillCatalogOptions = {
  appVersion?: string;
  builtinDirectory?: string;
  globalDirectory?: string;
  homeDirectory?: string;
  registryFile?: string;
};

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value.trim();
}

function parsePermissions(value: unknown, label: string): SkillPermission[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const permissions = value.map((item) => parseString(item, label) as SkillPermission);
  if (permissions.some((permission) => !PERMISSIONS.has(permission))) throw new Error(`${label} 包含未知权限。`);
  return [...new Set(permissions)];
}

function parseScript(value: unknown, id: string): SkillScriptManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`脚本 ${id} 配置无效。`);
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => key !== "entry" && key !== "description" && key !== "permissions");
  if (unsupported.length > 0) throw new Error(`脚本 ${id} 包含未知字段：${unsupported.join(", ")}`);
  const entry = parseString(record.entry, `脚本 ${id} entry`);
  if (!entry.startsWith("scripts/") || !entry.endsWith(".mjs")) throw new Error(`脚本 ${id} 必须指向 scripts/*.mjs。`);
  const permissions = parsePermissions(record.permissions, `脚本 ${id} permissions`);
  if (!permissions.includes("local_code_execution")) throw new Error(`脚本 ${id} 必须声明 local_code_execution。`);
  return {
    description: parseString(record.description, `脚本 ${id} description`),
    entry,
    permissions
  };
}

export function parseSkillManifest(raw: string): SkillManifest {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("skill.json 必须是对象。");
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => ![
    "schemaVersion", "displayName", "version", "publisher", "minDeepCreatorVersion", "permissions", "scripts"
  ].includes(key));
  if (unsupported.length > 0) throw new Error(`skill.json 包含未知字段：${unsupported.join(", ")}`);
  if (record.schemaVersion !== 1) throw new Error("skill.json schemaVersion 必须为 1。");
  const version = parseString(record.version, "version");
  if (!VERSION_PATTERN.test(version)) throw new Error("version 必须符合 SemVer。");
  const minDeepCreatorVersion = parseString(record.minDeepCreatorVersion, "minDeepCreatorVersion");
  if (!VERSION_PATTERN.test(minDeepCreatorVersion)) throw new Error("minDeepCreatorVersion 必须符合 SemVer。");
  const scriptsValue = record.scripts;
  let scripts: Record<string, SkillScriptManifest> | undefined;
  if (scriptsValue !== undefined) {
    if (!scriptsValue || typeof scriptsValue !== "object" || Array.isArray(scriptsValue)) throw new Error("scripts 必须是对象。");
    scripts = Object.fromEntries(Object.entries(scriptsValue as Record<string, unknown>).map(([id, script]) => {
      if (!NAME_PATTERN.test(id)) throw new Error(`脚本 ID 无效：${id}`);
      return [id, parseScript(script, id)];
    }));
  }
  const permissions = parsePermissions(record.permissions, "permissions");
  for (const [id, script] of Object.entries(scripts ?? {})) {
    const excessive = script.permissions.filter((permission) => !permissions.includes(permission));
    if (excessive.length > 0) throw new Error(`脚本 ${id} 权限超出 Skill 声明：${excessive.join(", ")}`);
  }
  return {
    displayName: parseString(record.displayName, "displayName"),
    minDeepCreatorVersion,
    permissions,
    publisher: parseString(record.publisher, "publisher"),
    schemaVersion: 1,
    scripts,
    version
  };
}

function parseVersion(value: string): { core: [number, number, number]; prerelease: string[] } {
  const match = value.match(VERSION_PATTERN);
  if (!match) throw new Error(`版本不符合 SemVer：${value}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function skillFiles(directory: string): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Skill 不允许符号链接：${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(relative);
      else throw new Error(`Skill 包含不支持的文件：${relative}`);
    }
  };
  visit(directory);
  return output;
}

export function skillRevisionHash(directory: string): string {
  const hash = createHash("sha256");
  for (const relative of skillFiles(directory)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(directory, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseSkillFrontmatter(source: string): { body: string; description: string; name: string } {
  const raw = readFileSync(source, "utf8").trim();
  if (!raw) throw new Error("SKILL.md 不能为空。");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("SKILL.md 缺少 YAML frontmatter。");
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) throw new Error("SKILL.md frontmatter 无效。");
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL.md frontmatter 必须是对象。");
  const metadata = value as Record<string, unknown>;
  const unsupported = Object.keys(metadata).filter((key) => key !== "name" && key !== "description");
  if (unsupported.length > 0) throw new Error(`SKILL.md frontmatter 不支持字段：${unsupported.join(", ")}`);
  const name = parseString(metadata.name, "Skill name");
  if (!NAME_PATTERN.test(name) || name.length > 64) throw new Error(`Skill name 无效：${name}`);
  return {
    body: raw.slice(match[0].length).trim(),
    description: parseString(metadata.description, "Skill description").slice(0, 240),
    name
  };
}

function collectDirectories(root: string | undefined): string[] {
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) return [];
  const direct = path.join(root, "SKILL.md");
  if (existsSync(direct)) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function registryKey(origin: SkillOrigin, name: string, projectRoot?: string): string {
  return origin === "project" ? `${origin}:${path.resolve(projectRoot ?? "")}:${name}` : `${origin}:${name}`;
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

export class SkillCatalog {
  readonly appVersion: string;
  readonly builtinDirectory?: string;
  readonly globalDirectory: string;
  readonly registryFile: string;

  constructor(options: SkillCatalogOptions = {}) {
    const home = options.homeDirectory ?? homedir();
    this.appVersion = options.appVersion ?? "0.1.0";
    this.builtinDirectory = options.builtinDirectory ? path.resolve(options.builtinDirectory) : undefined;
    this.globalDirectory = options.globalDirectory
      ? path.resolve(options.globalDirectory)
      : path.join(home, ".deepcreator", "skills");
    this.registryFile = options.registryFile ?? path.join(home, ".deepcreator", "skill-registry.json");
  }

  registry(): SkillRegistryRecord {
    try {
      if (!existsSync(this.registryFile)) return {};
      const value = JSON.parse(readFileSync(this.registryFile, "utf8")) as SkillRegistryRecord;
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  all(projectRoot: string): LoadedSkill[] {
    const registry = this.registry();
    const candidates = [
      ...collectDirectories(this.builtinDirectory).map((directory) => this.load(directory, "builtin", projectRoot, registry)),
      ...collectDirectories(this.globalDirectory).map((directory) => this.load(directory, "global", projectRoot, registry)),
      ...collectDirectories(path.join(projectRoot, ".deepcreator", "skills")).map((directory) => this.load(directory, "project", projectRoot, registry))
    ].flatMap((skill) => skill ?? []);
    const builtinNames = new Set(candidates.filter((skill) => skill.origin === "builtin").map((skill) => skill.name));
    const projectNames = new Set(candidates.filter((skill) => skill.origin === "project").map((skill) => skill.name));
    return candidates.map((skill) => {
      const conflict = skill.origin !== "builtin" && builtinNames.has(skill.name)
        ? `内置 Skill ${skill.name} 锁定了该名称。`
        : skill.origin === "global" && projectNames.has(skill.name)
          ? `当前项目的 Skill ${skill.name} 优先于全局版本。`
          : undefined;
      return conflict ? { ...skill, conflict } : skill;
    });
  }

  effective(projectRoot: string): LoadedSkill[] {
    return this.all(projectRoot).filter((skill) => skill.enabled && !skill.conflict);
  }

  find(projectRoot: string, capabilityId: string): LoadedSkill | undefined {
    return this.effective(projectRoot).find((skill) => skill.capabilityId === capabilityId);
  }

  inspect(directory: string, origin: SkillOrigin = "global", projectRoot = directory): LoadedSkill {
    return this.loadUnsafe(path.resolve(directory), origin, projectRoot, {});
  }

  readReference(projectRoot: string, capabilityId: string, relativePath: string, maxChars = 200_000): string {
    const skill = this.require(projectRoot, capabilityId);
    const target = this.resourcePath(skill, "references", relativePath);
    const text = readFileSync(target, "utf8");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[内容已截断]` : text;
  }

  assetPath(projectRoot: string, capabilityId: string, relativePath: string): string {
    return this.resourcePath(this.require(projectRoot, capabilityId), "assets", relativePath);
  }

  script(projectRoot: string, capabilityId: string, scriptId: string): { skill: LoadedSkill; script: SkillScriptManifest; path: string } {
    const skill = this.require(projectRoot, capabilityId);
    if (!skill.manifest || !skill.trusted) throw new Error("该 Skill 未受信任，不能运行脚本。");
    const script = skill.manifest.scripts?.[scriptId];
    if (!script) throw new Error(`Skill 未声明脚本：${scriptId}`);
    const target = path.resolve(skill.directory, script.entry);
    if (!isInside(path.join(skill.directory, "scripts"), target) || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
      throw new Error(`Skill 脚本路径无效：${script.entry}`);
    }
    return { path: target, script, skill };
  }

  private require(projectRoot: string, capabilityId: string): LoadedSkill {
    const skill = this.find(projectRoot, capabilityId);
    if (!skill) throw new Error(`未找到 Skill：${capabilityId}`);
    return skill;
  }

  private resourcePath(skill: LoadedSkill, directory: "assets" | "references", relativePath: string): string {
    const root = path.join(skill.directory, directory);
    const target = path.resolve(root, relativePath);
    if (!relativePath || !isInside(root, target) || !existsSync(target) || !statSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
      throw new Error(`Skill 资源路径无效：${relativePath}`);
    }
    return target;
  }

  private load(directory: string, origin: SkillOrigin, projectRoot: string, registry: SkillRegistryRecord): LoadedSkill | undefined {
    try {
      return this.loadUnsafe(directory, origin, projectRoot, registry);
    } catch {
      return undefined;
    }
  }

  private loadUnsafe(directory: string, origin: SkillOrigin, projectRoot: string, registry: SkillRegistryRecord): LoadedSkill {
    const source = path.join(directory, "SKILL.md");
    const parsed = parseSkillFrontmatter(source);
    if (path.basename(directory) !== parsed.name) throw new Error("Skill 目录名必须与 name 一致。");
    const manifestPath = path.join(directory, "skill.json");
    const manifest = existsSync(manifestPath) ? parseSkillManifest(readFileSync(manifestPath, "utf8")) : undefined;
    if (origin === "builtin" && !manifest) throw new Error("内置 Skill 必须包含 skill.json。");
    if (manifest && compareVersions(this.appVersion, manifest.minDeepCreatorVersion) < 0) {
      throw new Error(`Skill 需要 DeepCreator ${manifest.minDeepCreatorVersion} 或更高版本。`);
    }
    for (const script of Object.values(manifest?.scripts ?? {})) {
      const scriptPath = path.resolve(directory, script.entry);
      if (!isInside(path.join(directory, "scripts"), scriptPath) || !existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
        throw new Error(`Skill 脚本不存在：${script.entry}`);
      }
    }
    const revisionHash = skillRevisionHash(directory);
    const key = registryKey(origin, parsed.name, projectRoot);
    const install = registry.installs?.[key];
    const trusted = origin === "builtin" || Boolean(install?.trusted && install.revisionHash === revisionHash);
    return {
      body: parsed.body,
      capabilityId: `skill:${parsed.name}:${revisionHash.slice(0, 12)}`,
      description: parsed.description,
      directory,
      displayName: manifest?.displayName ?? parsed.name,
      enabled: !(registry.disabled ?? []).includes(key),
      legacy: !manifest,
      locked: origin === "builtin",
      manifest,
      name: parsed.name,
      origin,
      permissions: manifest?.permissions ?? ["workspace_read"],
      publisher: manifest?.publisher ?? "Legacy",
      revisionHash,
      source,
      trusted,
      updateState: install?.updateState ?? (install?.sourceKind === "github" ? "current" : "unsupported"),
      version: manifest?.version ?? "0.0.0"
    };
  }
}

export const defaultSkillCatalog = new SkillCatalog();
