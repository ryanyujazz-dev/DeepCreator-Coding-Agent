import AdmZip from "adm-zip";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  SkillInstallInput,
  SkillInstallPreview,
  SkillInstallScope,
  SkillInstallSource,
  SkillOrigin,
  SkillSummary,
  SkillTargetInput
} from "../../shared/contracts/skill";
import {
  compareVersions,
  LoadedSkill,
  parseSkillFrontmatter,
  SkillCatalog,
  SkillRegistryRecord
} from "./skillCatalog";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 500;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type PreviewRecord = {
  cleanupDirectory: string;
  createdAt: number;
  directory: string;
  preview: SkillInstallPreview;
};

type GitHubRelease = {
  assets?: Array<{ browser_download_url?: string; name?: string; size?: number }>;
  html_url?: string;
  tag_name?: string;
};

export type SkillStoreOptions = {
  appVersion: string;
  builtinDirectory?: string;
  globalDirectory: string;
  previewDirectory: string;
  registryFile: string;
  trash: (target: string) => Promise<void>;
};

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function recordKey(origin: SkillOrigin, name: string, projectRoot?: string): string {
  return origin === "project" ? `${origin}:${path.resolve(projectRoot ?? "")}:${name}` : `${origin}:${name}`;
}

function summary(skill: LoadedSkill): SkillSummary {
  return {
    capabilityId: skill.capabilityId,
    conflict: skill.conflict,
    description: skill.description,
    displayName: skill.displayName,
    enabled: skill.enabled,
    legacy: skill.legacy,
    locked: skill.locked,
    name: skill.name,
    origin: skill.origin,
    permissions: skill.permissions,
    publisher: skill.publisher,
    revisionHash: skill.revisionHash,
    source: skill.source,
    trusted: skill.trusted,
    updateState: skill.updateState,
    version: skill.version
  };
}

function sourceFiles(directory: string): Array<{ path: string; size: number }> {
  const files: Array<{ path: string; size: number }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Skill 不允许符号链接：${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ path: relative, size: statSync(absolute).size });
      else throw new Error(`Skill 包含不支持的文件：${relative}`);
    }
  };
  visit(directory);
  if (files.length > MAX_FILES) throw new Error(`Skill 文件数量不能超过 ${MAX_FILES}。`);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_EXTRACTED_BYTES) throw new Error("Skill 解压后不能超过 50 MiB。");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeArchivePath(raw: string): string {
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error(`ZIP 路径无效：${raw}`);
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`ZIP 路径越界：${raw}`);
  }
  return normalized;
}

function stripSingleRoot(directory: string): string {
  if (existsSync(path.join(directory, "SKILL.md"))) return directory;
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== ".DS_Store");
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(directory, entries[0].name);
    if (existsSync(path.join(nested, "SKILL.md"))) return nested;
  }
  throw new Error("Skill 包根目录必须包含 SKILL.md。");
}

function normalizeSkillRoot(directory: string): string {
  const root = stripSingleRoot(directory);
  const name = parseSkillFrontmatter(path.join(root, "SKILL.md")).name;
  if (path.basename(root) === name) return root;
  const normalized = path.join(path.dirname(root), name);
  if (existsSync(normalized)) throw new Error(`Skill 包内存在名称冲突：${name}`);
  renameSync(root, normalized);
  return normalized;
}

function repositoryFromUrl(rawUrl: string): { owner: string; repository: string; tag?: string } {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("只支持公开 GitHub HTTPS 地址。");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub 地址缺少 owner/repository。");
  const repository = parts[1].replace(/\.git$/, "");
  const tagIndex = parts.findIndex((part, index) => part === "tag" && parts[index - 1] === "releases");
  const downloadIndex = parts.findIndex((part, index) => part === "download" && parts[index - 1] === "releases");
  const tag = tagIndex >= 0 ? parts[tagIndex + 1] : downloadIndex >= 0 ? parts[downloadIndex + 1] : undefined;
  return { owner: parts[0], repository, tag };
}

export class SkillStore {
  private readonly catalog: SkillCatalog;
  private readonly previews = new Map<string, PreviewRecord>();

  constructor(private readonly options: SkillStoreOptions) {
    this.catalog = new SkillCatalog({
      appVersion: options.appVersion,
      builtinDirectory: options.builtinDirectory,
      globalDirectory: options.globalDirectory,
      registryFile: options.registryFile
    });
    mkdirSync(options.globalDirectory, { recursive: true });
    mkdirSync(options.previewDirectory, { recursive: true });
  }

  list(projectRoot?: string): SkillSummary[] {
    return this.catalog.all(path.resolve(projectRoot ?? path.dirname(this.options.globalDirectory))).map(summary);
  }

  previewLocal(sourcePath: string): SkillInstallPreview {
    const source = path.resolve(sourcePath);
    if (!existsSync(source)) throw new Error("所选 Skill 不存在。");
    const sourceInfo = statSync(source);
    if (!sourceInfo.isDirectory() && !sourceInfo.isFile()) throw new Error("Skill 必须是文件夹或 ZIP 包。");
    const staging = this.createStaging();
    if (sourceInfo.isDirectory()) {
      cpSync(source, staging, { errorOnExist: false, recursive: true, verbatimSymlinks: true });
      return this.buildPreview(normalizeSkillRoot(staging), { kind: "local", label: path.basename(source) }, path.dirname(staging));
    }
    if (sourceInfo.size > MAX_ARCHIVE_BYTES) throw new Error("Skill 包不能超过 20 MiB。");
    this.extractZip(readFileSync(source), staging);
    return this.buildPreview(normalizeSkillRoot(staging), { kind: "local", label: path.basename(source) }, path.dirname(staging));
  }

  async previewGitHub(rawUrl: string): Promise<SkillInstallPreview> {
    const repository = repositoryFromUrl(rawUrl);
    const release = await this.githubRelease(repository.owner, repository.repository, repository.tag);
    const asset = release.assets?.find((item) => item.name?.endsWith(".deepcreator-skill"));
    if (!asset?.browser_download_url) throw new Error("该 GitHub Release 没有 .deepcreator-skill 资源。");
    if ((asset.size ?? 0) > MAX_ARCHIVE_BYTES) throw new Error("Skill 包不能超过 20 MiB。");
    const data = await this.download(asset.browser_download_url);
    const staging = this.createStaging();
    this.extractZip(data, staging);
    return this.buildPreview(normalizeSkillRoot(staging), {
      kind: "github",
      releaseUrl: release.html_url ?? rawUrl,
      repository: `${repository.owner}/${repository.repository}`
    }, path.dirname(staging));
  }

  install(input: SkillInstallInput): SkillSummary[] {
    this.prunePreviews();
    const record = this.previews.get(input.previewId);
    if (!record) throw new Error("安装预览已失效，请重新选择 Skill。");
    if (!input.trusted) throw new Error("安装 Skill 前必须确认信任其内容与权限。");
    const projectRoot = this.projectRoot(input.scope, input.projectRoot);
    const inspected = this.catalog.inspect(record.directory, input.scope, projectRoot);
    if (inspected.revisionHash !== record.preview.revisionHash) {
      throw new Error("Skill 内容在安全预览后发生变化，请重新生成预览并确认。");
    }
    const builtinNames = new Set(this.catalog.all(projectRoot).filter((skill) => skill.origin === "builtin").map((skill) => skill.name));
    if (builtinNames.has(inspected.name)) throw new Error(`内置 Skill ${inspected.name} 锁定了该名称。`);
    const parent = input.scope === "global" ? this.options.globalDirectory : path.join(projectRoot, ".deepcreator", "skills");
    mkdirSync(parent, { recursive: true });
    const target = path.join(parent, inspected.name);
    const transaction = randomUUID();
    const prepared = path.join(parent, `.${inspected.name}.install-${transaction}`);
    const backup = path.join(parent, `.${inspected.name}.backup-${transaction}`);
    cpSync(record.directory, prepared, { errorOnExist: true, recursive: true, verbatimSymlinks: true });
    let backedUp = false;
    let installedNew = false;
    try {
      if (existsSync(target)) {
        renameSync(target, backup);
        backedUp = true;
      }
      renameSync(prepared, target);
      installedNew = true;
      const installed = this.catalog.inspect(target, input.scope, projectRoot);
      const registry = this.catalog.registry();
      registry.installs ??= {};
      registry.installs[recordKey(input.scope, inspected.name, projectRoot)] = {
        releaseUrl: record.preview.source.kind === "github" ? record.preview.source.releaseUrl : undefined,
        repository: record.preview.source.kind === "github" ? record.preview.source.repository : undefined,
        revisionHash: installed.revisionHash,
        sourceKind: record.preview.source.kind,
        trusted: true,
        updateState: record.preview.source.kind === "github" ? "current" : "unsupported"
      };
      this.writeRegistry(registry);
      if (backedUp) rmSync(backup, { force: true, recursive: true });
      this.previews.delete(input.previewId);
      rmSync(record.cleanupDirectory, { force: true, recursive: true });
      return this.list(input.projectRoot);
    } catch (error) {
      rmSync(prepared, { force: true, recursive: true });
      if (installedNew) rmSync(target, { force: true, recursive: true });
      if (backedUp && existsSync(backup)) {
        renameSync(backup, target);
      }
      throw error;
    }
  }

  preview(previewId: string): SkillInstallPreview {
    this.prunePreviews();
    const record = this.previews.get(previewId);
    if (!record) throw new Error("安装预览已失效，请重新选择 Skill。");
    return structuredClone(record.preview);
  }

  setEnabled(input: SkillTargetInput & { enabled: boolean }): SkillSummary[] {
    const projectRoot = this.projectRoot(input.scope === "builtin" ? "global" : input.scope, input.projectRoot);
    const skills = this.catalog.all(projectRoot);
    const match = skills.find((skill) => skill.name === input.name && skill.origin === input.scope);
    if (!match) throw new Error(`未找到 Skill：${input.name}`);
    const key = recordKey(input.scope, input.name, projectRoot);
    const registry = this.catalog.registry();
    const disabled = new Set(registry.disabled ?? []);
    if (input.enabled) disabled.delete(key);
    else disabled.add(key);
    registry.disabled = [...disabled].sort();
    this.writeRegistry(registry);
    return this.list(input.projectRoot);
  }

  async remove(input: SkillTargetInput): Promise<SkillSummary[]> {
    if (input.scope === "builtin") throw new Error("内置 Skill 不能卸载。");
    const projectRoot = this.projectRoot(input.scope, input.projectRoot);
    const parent = input.scope === "global" ? this.options.globalDirectory : path.join(projectRoot, ".deepcreator", "skills");
    const target = path.join(parent, input.name);
    if (!isInside(parent, target) || !existsSync(target)) throw new Error(`未找到 Skill：${input.name}`);
    await this.options.trash(target);
    const registry = this.catalog.registry();
    delete registry.installs?.[recordKey(input.scope, input.name, projectRoot)];
    registry.disabled = (registry.disabled ?? []).filter((key) => key !== recordKey(input.scope, input.name, projectRoot));
    this.writeRegistry(registry);
    return this.list(input.projectRoot);
  }

  async checkUpdates(projectRoot?: string): Promise<SkillSummary[]> {
    const registry = this.catalog.registry();
    const now = Date.now();
    await Promise.all(Object.entries(registry.installs ?? {}).map(async ([key, install]) => {
      if (install.sourceKind !== "github" || !install.repository) return;
      if (install.checkedAt && now - Date.parse(install.checkedAt) < UPDATE_INTERVAL_MS) return;
      try {
        const [owner, repository] = install.repository.split("/", 2);
        const release = await this.githubRelease(owner, repository);
        const version = String(release.tag_name ?? "").replace(/^v/, "");
        const current = this.skillForRegistryKey(key, projectRoot)?.version;
        install.availableVersion = version || undefined;
        install.releaseUrl = release.html_url ?? install.releaseUrl;
        install.updateState = !VERSION_PATTERN_SAFE(version)
          ? "unsupported"
          : current && compareVersions(version, current) > 0
            ? "available"
            : "current";
      } catch {
        install.updateState = "failed";
      }
      install.checkedAt = new Date().toISOString();
    }));
    this.writeRegistry(registry);
    return this.list(projectRoot);
  }

  async update(input: SkillTargetInput): Promise<SkillInstallPreview> {
    if (input.scope === "builtin") throw new Error("内置 Skill 只能随应用更新。");
    const projectRoot = this.projectRoot(input.scope, input.projectRoot);
    const install = this.catalog.registry().installs?.[recordKey(input.scope, input.name, projectRoot)];
    if (!install?.repository) throw new Error("该 Skill 没有可用的 GitHub 更新源。");
    return this.previewGitHub(`https://github.com/${install.repository}`);
  }

  private skillForRegistryKey(key: string, projectRoot?: string): SkillSummary | undefined {
    return this.list(projectRoot).find((skill) => recordKey(skill.origin, skill.name, projectRoot) === key);
  }

  private projectRoot(scope: SkillInstallScope, projectRoot?: string): string {
    if (scope === "global") return path.dirname(this.options.globalDirectory);
    if (!projectRoot) throw new Error("安装项目 Skill 时必须提供项目目录。");
    const resolved = path.resolve(projectRoot);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error("项目目录不存在。");
    return resolved;
  }

  private createStaging(): string {
    const container = path.join(this.options.previewDirectory, `preview-${randomUUID()}`);
    const content = path.join(container, "content");
    mkdirSync(content, { recursive: true });
    return content;
  }

  private buildPreview(directory: string, source: SkillInstallSource, cleanupDirectory: string): SkillInstallPreview {
    const inspected = this.catalog.inspect(directory);
    const files = sourceFiles(directory);
    const previewId = randomUUID();
    const preview: SkillInstallPreview = {
      description: inspected.description,
      displayName: inspected.displayName,
      files,
      minDeepCreatorVersion: inspected.manifest?.minDeepCreatorVersion ?? "0.0.0",
      name: inspected.name,
      permissions: inspected.permissions,
      previewId,
      publisher: inspected.publisher,
      revisionHash: inspected.revisionHash,
      scripts: Object.entries(inspected.manifest?.scripts ?? {}).map(([id, script]) => ({
        description: script.description,
        id,
        permissions: script.permissions
      })),
      source,
      version: inspected.version
    };
    this.previews.set(previewId, { cleanupDirectory, createdAt: Date.now(), directory, preview });
    return preview;
  }

  private extractZip(data: Buffer, target: string): void {
    if (data.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Skill 包不能超过 20 MiB。");
    const archive = new AdmZip(data);
    const entries = archive.getEntries();
    if (entries.length > MAX_FILES) throw new Error(`Skill 文件数量不能超过 ${MAX_FILES}。`);
    let extractedBytes = 0;
    const seen = new Set<string>();
    for (const entry of entries) {
      const relative = normalizeArchivePath(entry.entryName);
      if (seen.has(relative.toLowerCase())) throw new Error(`ZIP 包含重复路径：${relative}`);
      seen.add(relative.toLowerCase());
      const unixMode = (entry.header.attr >>> 16) & 0o170000;
      if (unixMode === 0o120000) throw new Error(`ZIP 不允许符号链接：${relative}`);
      if (unixMode !== 0 && unixMode !== 0o100000 && unixMode !== 0o040000) {
        throw new Error(`ZIP 不允许设备文件或特殊文件：${relative}`);
      }
      const absolute = path.resolve(target, ...relative.split("/"));
      if (!isInside(target, absolute)) throw new Error(`ZIP 路径越界：${relative}`);
      if (entry.isDirectory) {
        mkdirSync(absolute, { recursive: true });
        continue;
      }
      extractedBytes += Number(entry.header.size ?? 0);
      if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("Skill 解压后不能超过 50 MiB。");
      const content = entry.getData();
      if (content.byteLength !== Number(entry.header.size ?? content.byteLength)) throw new Error(`ZIP 文件大小无效：${relative}`);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, { mode: 0o600 });
    }
  }

  private async githubRelease(owner: string, repository: string, tag?: string): Promise<GitHubRelease> {
    const endpoint = tag
      ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(tag)}`
      : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/latest`;
    const response = await fetch(endpoint, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "DeepCreator" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`GitHub Release 查询失败：HTTP ${response.status}`);
    return await response.json() as GitHubRelease;
  }

  private async download(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("只允许下载 GitHub Release 资源。");
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Skill 下载失败：HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_ARCHIVE_BYTES) throw new Error("Skill 包不能超过 20 MiB。");
    if (!response.body) throw new Error("Skill 下载响应没有内容。");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("Skill 包不能超过 20 MiB。");
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, received);
  }

  private writeRegistry(registry: SkillRegistryRecord): void {
    mkdirSync(path.dirname(this.options.registryFile), { recursive: true });
    const temporary = `${this.options.registryFile}.tmp-${randomUUID()}`;
    const backup = `${this.options.registryFile}.backup-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    let backedUp = false;
    try {
      if (existsSync(this.options.registryFile)) {
        renameSync(this.options.registryFile, backup);
        backedUp = true;
      }
      renameSync(temporary, this.options.registryFile);
      if (backedUp) rmSync(backup, { force: true });
    } catch (error) {
      rmSync(temporary, { force: true });
      if (backedUp && existsSync(backup)) renameSync(backup, this.options.registryFile);
      throw error;
    }
  }

  private prunePreviews(): void {
    const now = Date.now();
    for (const [id, record] of this.previews) {
      if (now - record.createdAt <= PREVIEW_TTL_MS) continue;
      this.previews.delete(id);
      rmSync(record.cleanupDirectory, { force: true, recursive: true });
    }
  }
}

function VERSION_PATTERN_SAFE(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}
