import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore } from "../desktop/skillStore";
import { agentDefinition, createAgentToolHost } from "../server/app/agentDefinitions";
import { approvalFor } from "../server/domain/accessPolicy";
import { SkillPermission } from "../shared/contracts/skill";
import { invokeCapability } from "../server/infra/capabilities";
import { compareVersions, parseSkillManifest, SkillCatalog } from "../server/infra/skillCatalog";
import { createToolHost, executeTool } from "../server/infra/tools";
import { materializeSkillAsset, readSkillResource, skillScriptCommand } from "../server/infra/tools/skills";

function createSkill(input: {
  legacy?: boolean;
  name: string;
  parent: string;
  permissions?: SkillPermission[];
  scripts?: boolean;
  scriptPermissions?: SkillPermission[];
  version?: string;
}): string {
  const directory = path.join(input.parent, input.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${input.name}\ndescription: ${input.name} description\n---\n\n# ${input.name}\n\nFollow the repository evidence.\n`);
  if (!input.legacy) {
    const scripts = input.scripts ? {
      validate: {
        description: "Validate the project",
        entry: "scripts/validate.mjs",
        permissions: input.scriptPermissions ?? ["workspace_read", "local_code_execution"]
      }
    } : undefined;
    writeFileSync(path.join(directory, "skill.json"), `${JSON.stringify({
      displayName: input.name,
      minDeepCreatorVersion: "0.1.0",
      permissions: input.permissions ?? (input.scripts ? ["workspace_read", "local_code_execution"] : ["workspace_read"]),
      publisher: "DeepCreator",
      schemaVersion: 1,
      scripts,
      version: input.version ?? "1.0.0"
    }, null, 2)}\n`);
    if (input.scripts) {
      mkdirSync(path.join(directory, "scripts"), { recursive: true });
      writeFileSync(path.join(directory, "scripts", "validate.mjs"), "console.log('ok');\n");
    }
  }
  return directory;
}

test("Skill manifests enforce SemVer and compare prerelease identifiers correctly", () => {
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  const manifest = {
    displayName: "Example",
    minDeepCreatorVersion: "0.1.0",
    permissions: ["workspace_read"],
    publisher: "DeepCreator",
    schemaVersion: 1,
    version: "01.0.0"
  };
  assert.throws(() => parseSkillManifest(JSON.stringify(manifest)), /SemVer/);
});

test("SkillCatalog enforces builtin and project precedence while preserving legacy skills", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skills-"));
  try {
    const home = path.join(root, "home");
    const builtin = path.join(root, "builtin");
    const project = path.join(root, "project");
    mkdirSync(project, { recursive: true });
    const global = path.join(home, ".deepcreator", "skills");
    const projectSkills = path.join(project, ".deepcreator", "skills");
    createSkill({ name: "locked-skill", parent: builtin });
    createSkill({ name: "locked-skill", parent: global, version: "2.0.0" });
    createSkill({ name: "shared-skill", parent: global });
    createSkill({ name: "shared-skill", parent: projectSkills, version: "2.0.0" });
    createSkill({ legacy: true, name: "legacy-skill", parent: global });
    const catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory: builtin, homeDirectory: home });

    const all = catalog.all(project);
    assert.equal(all.find((skill) => skill.name === "locked-skill" && skill.origin === "builtin")?.conflict, undefined);
    assert.match(all.find((skill) => skill.name === "locked-skill" && skill.origin === "global")?.conflict ?? "", /内置/);
    assert.match(all.find((skill) => skill.name === "shared-skill" && skill.origin === "global")?.conflict ?? "", /当前项目/);
    assert.equal(catalog.effective(project).find((skill) => skill.name === "shared-skill")?.origin, "project");
    assert.equal(catalog.effective(project).find((skill) => skill.name === "legacy-skill")?.legacy, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Skill invocation resolves a stale content hash to the current enabled revision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-stale-skill-id-"));
  try {
    const builtin = path.join(root, "builtin");
    const project = path.join(root, "project");
    const directory = createSkill({ name: "changing-skill", parent: builtin });
    const catalog = new SkillCatalog({
      appVersion: "0.1.0",
      builtinDirectory: builtin,
      homeDirectory: path.join(root, "home")
    });
    const staleId = catalog.effective(project)[0].capabilityId;
    writeFileSync(path.join(directory, "SKILL.md"), "---\nname: changing-skill\ndescription: current description\n---\n\n# Current instructions\n");

    const loaded = await invokeCapability(project, staleId, {}, undefined, catalog);

    assert.notEqual(loaded.capability.capabilityId, staleId);
    assert.equal(loaded.capability.name, "changing-skill");
    assert.match(loaded.contextUpdate ?? "", /Current instructions/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Skill resources stay inside package roots and trusted scripts use a minimal environment", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-resources-"));
  try {
    const builtin = path.join(root, "builtin");
    const project = path.join(root, "project");
    const directory = createSkill({ name: "resource-skill", parent: builtin, scripts: true });
    mkdirSync(path.join(directory, "references"), { recursive: true });
    mkdirSync(path.join(directory, "assets"), { recursive: true });
    writeFileSync(path.join(directory, "references", "guide.md"), "safe guide\n");
    writeFileSync(path.join(directory, "assets", "template.txt"), "template\n");
    const catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory: builtin, homeDirectory: path.join(root, "home") });
    const capabilityId = catalog.effective(project)[0].capabilityId;

    assert.equal(readSkillResource(catalog, project, { capabilityId, path: "guide.md" }), "safe guide\n");
    assert.throws(() => readSkillResource(catalog, project, { capabilityId, path: "../SKILL.md" }), /路径无效/);
    materializeSkillAsset(catalog, project, { capabilityId, path: "template.txt", target: "generated/template.txt" });
    assert.equal(readFileSync(path.join(project, "generated", "template.txt"), "utf8"), "template\n");
    assert.throws(() => materializeSkillAsset(catalog, project, {
      capabilityId,
      path: "template.txt",
      target: "../outside.txt"
    }), /项目根目录/);
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const linked = path.join(project, "linked");
    if (process.platform !== "win32") {
      symlinkSync(outside, linked, "dir");
      assert.throws(() => materializeSkillAsset(catalog, project, {
        capabilityId,
        path: "template.txt",
        target: "linked/escaped.txt"
      }), /符号链接/);
    }
    const command = skillScriptCommand(catalog, project, { capabilityId, scriptId: "validate", args: ["--check"] });
    assert.match(command.command, /validate\.mjs/);
    assert.equal(command.env.OPENAI_API_KEY, undefined);
    assert.equal(command.env.GITHUB_TOKEN, undefined);
    assert.equal(command.mutatesWorkspace, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("SkillStore previews, installs, disables and removes a local Skill transactionally", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-store-"));
  try {
    const home = path.join(root, "home");
    const globalDirectory = path.join(home, ".deepcreator", "skills");
    const sourceParent = path.join(root, "source");
    const source = createSkill({ name: "third-party", parent: sourceParent, scripts: true });
    const store = new SkillStore({
      appVersion: "0.1.0",
      builtinDirectory: path.join(root, "builtin"),
      globalDirectory,
      previewDirectory: path.join(root, "previews"),
      registryFile: path.join(home, ".deepcreator", "skill-registry.json"),
      trash: async (target) => rmSync(target, { force: true, recursive: true })
    });
    const preview = store.previewLocal(source);
    assert.equal(preview.name, "third-party");
    assert.equal(preview.scripts[0].id, "validate");
    let installed = store.install({ previewId: preview.previewId, scope: "global", trusted: true });
    assert.equal(installed.find((skill) => skill.name === "third-party")?.trusted, true);
    installed = store.setEnabled({ enabled: false, name: "third-party", scope: "global" });
    assert.equal(installed.find((skill) => skill.name === "third-party")?.enabled, false);
    installed = await store.remove({ name: "third-party", scope: "global" });
    assert.equal(installed.some((skill) => skill.name === "third-party"), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("SkillStore rejects staged content that changes after the trusted preview", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-preview-integrity-"));
  try {
    const previewDirectory = path.join(root, "previews");
    const source = createSkill({ name: "tamper-skill", parent: path.join(root, "source") });
    const store = new SkillStore({
      appVersion: "0.1.0",
      builtinDirectory: path.join(root, "builtin"),
      globalDirectory: path.join(root, "home", ".deepcreator", "skills"),
      previewDirectory,
      registryFile: path.join(root, "home", ".deepcreator", "skill-registry.json"),
      trash: async () => undefined
    });
    const preview = store.previewLocal(source);
    const container = readdirSync(previewDirectory)[0];
    writeFileSync(path.join(previewDirectory, container, "tamper-skill", "SKILL.md"), "---\nname: tamper-skill\ndescription: changed after preview\n---\n");
    assert.throws(
      () => store.install({ previewId: preview.previewId, scope: "global", trusted: true }),
      /安全预览后发生变化/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("SkillStore rejects linked local sources and ZIP parent path segments", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-source-boundary-"));
  try {
    const source = createSkill({ name: "boundary-skill", parent: path.join(root, "source") });
    const previewDirectory = path.join(root, "previews");
    const store = new SkillStore({
      appVersion: "0.1.0",
      builtinDirectory: path.join(root, "builtin"),
      globalDirectory: path.join(root, "home", ".deepcreator", "skills"),
      previewDirectory,
      registryFile: path.join(root, "home", ".deepcreator", "skill-registry.json"),
      trash: async () => undefined
    });

    if (process.platform !== "win32") {
      const linkedSource = path.join(root, "linked-skill");
      symlinkSync(source, linkedSource, "dir");
      assert.throws(() => store.previewLocal(linkedSource), /不能是符号链接/);
    }

    const archive = new AdmZip();
    archive.addFile("SKILL.md", Buffer.from("---\nname: boundary-skill\ndescription: boundary\n---\n"));
    archive.getEntries()[0].entryName = "nested/../SKILL.md";
    const packagePath = path.join(root, "boundary.deepcreator-skill");
    archive.writeZip(packagePath);
    assert.throws(() => store.previewLocal(packagePath), /不能包含 \.\./);
    assert.deepEqual(readdirSync(previewDirectory), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Agent installation uses injected user paths and hash-bound confirmation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-agent-skill-install-"));
  try {
    const project = path.join(root, "active-project");
    const globalDirectory = path.join(root, "portable-user-home", ".deepcreator", "skills");
    mkdirSync(project, { recursive: true });
    createSkill({ name: "portable-skill", parent: path.join(project, "authored"), scripts: true });
    createSkill({ name: "all-projects-skill", parent: path.join(project, "authored") });
    const store = new SkillStore({
      appVersion: "0.1.0",
      builtinDirectory: path.join(root, "builtin"),
      globalDirectory,
      previewDirectory: path.join(root, "agent-previews"),
      registryFile: path.join(root, "portable-user-home", ".deepcreator", "skill-registry.json"),
      trash: async () => undefined
    });

    await assert.rejects(
      executeTool({
        args: { source: "authored/portable-skill" },
        name: "preview_skill_install",
        projectRoot: project,
        skillStore: store
      }),
      /明确选择 Skill 安装范围/
    );

    const projectPreviewResult = await executeTool({
      args: { scope: "project", source: "authored/portable-skill" },
      name: "preview_skill_install",
      projectRoot: project,
      skillStore: store
    });
    const projectPreview = JSON.parse(projectPreviewResult.output) as {
      installRequest: Record<string, unknown>;
      preview: { revisionHash: string };
    };
    const approval = approvalFor({
      args: projectPreview.installRequest,
      grants: [],
      profile: "full_access",
      runId: "run_install",
      toolName: "install_skill"
    });
    assert.deepEqual(approval?.choices, ["allow_once", "deny"]);
    assert.match(approval?.detail ?? "", new RegExp(projectPreview.preview.revisionHash));
    const projectInstalled = await executeTool({
      args: projectPreview.installRequest,
      name: "install_skill",
      projectRoot: project,
      skillStore: store
    });
    assert.equal(projectInstalled.mutatedWorkspace, true);
    assert.equal(existsSync(path.join(project, ".deepcreator", "skills", "portable-skill", "SKILL.md")), true);

    const globalPreviewResult = await executeTool({
      args: { scope: "global", source: "authored/all-projects-skill" },
      name: "preview_skill_install",
      projectRoot: project,
      skillStore: store
    });
    const globalPreview = JSON.parse(globalPreviewResult.output) as { installRequest: Record<string, unknown> };
    assert.equal(JSON.stringify(globalPreview.installRequest).includes(root), false);
    const globalInstalled = await executeTool({
      args: globalPreview.installRequest,
      name: "install_skill",
      projectRoot: project,
      skillStore: store
    });
    assert.equal(globalInstalled.mutatedWorkspace, false);
    assert.equal(globalInstalled.output.includes(root), false);
    assert.equal(existsSync(path.join(globalDirectory, "all-projects-skill", "SKILL.md")), true);

    const mismatchPreviewResult = await executeTool({
      args: { scope: "global", source: "authored/all-projects-skill" },
      name: "preview_skill_install",
      projectRoot: project,
      skillStore: store
    });
    const mismatch = JSON.parse(mismatchPreviewResult.output) as { installRequest: Record<string, unknown> };
    await assert.rejects(
      executeTool({
        args: { ...mismatch.installRequest, publisher: "Spoofed Publisher" },
        name: "install_skill",
        projectRoot: project,
        skillStore: store
      }),
      /确认信息与安全预览不一致/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Worker agents can use the approval-gated Skill installation handoff", () => {
  const host = createAgentToolHost(createToolHost(), agentDefinition("worker"));
  assert.equal(host.has("preview_skill_install"), true);
  assert.equal(host.has("install_skill"), true);
  assert.equal(host.specs.some((tool) => tool.name === "preview_skill_install"), true);
  assert.equal(host.specs.some((tool) => tool.name === "install_skill"), true);
});

test("the application ships eight valid locked builtin Skills with three trigger evals each", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-builtin-skills-"));
  try {
    const builtinDirectory = path.resolve("skills");
    const catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory, homeDirectory: root });
    const builtins = catalog.all(path.join(root, "project"));
    assert.equal(builtins.length, 8);
    assert.equal(builtins.every((skill) => skill.locked && skill.trusted && !skill.legacy), true);
    const evals = JSON.parse(readFileSync(path.join(builtinDirectory, "evals.json"), "utf8")) as {
      cases: Array<{ kind: string; shouldInvoke: boolean; skill: string }>;
    };
    for (const skill of builtins) {
      const cases = evals.cases.filter((item) => item.skill === skill.name);
      assert.deepEqual(cases.map((item) => item.kind).sort(), ["error", "negative", "positive"]);
      assert.equal(cases.find((item) => item.kind === "negative")?.shouldInvoke, false);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-skill pack script produces an installable .deepcreator-skill archive", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-pack-"));
  try {
    const source = createSkill({ name: "packed-skill", parent: root });
    const output = path.join(root, "packed-skill.deepcreator-skill");
    const packed = spawnSync(process.execPath, [
      path.resolve("skills/create-skill/scripts/pack-skill.mjs"),
      path.basename(source),
      path.basename(output)
    ], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    assert.match(packed.stdout, /top-level Runtime tool preview_skill_install directly/);
    assert.match(packed.stdout, /not Skill scripts or capabilities/);
    const store = new SkillStore({
      appVersion: "0.1.0",
      builtinDirectory: path.join(root, "builtin"),
      globalDirectory: path.join(root, "home", ".deepcreator", "skills"),
      previewDirectory: path.join(root, "previews"),
      registryFile: path.join(root, "home", ".deepcreator", "skill-registry.json"),
      trash: async () => undefined
    });
    assert.equal(store.previewLocal(output).name, "packed-skill");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-skill init script creates a guarded, portable package skeleton", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-init-"));
  try {
    const initialized = spawnSync(process.execPath, [
      path.resolve("skills/create-skill/scripts/init-skill.mjs"),
      "create-report",
      "--description", "Create a structured report from project evidence. Use when a user asks for a reusable report workflow.",
      "--publisher", "Example Publisher",
      "--path", "authored",
      "--resources", "references,scripts,assets"
    ], { cwd: root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const directory = path.join(root, "authored", "create-report");
    assert.equal(existsSync(path.join(directory, "SKILL.md")), true);
    assert.equal(existsSync(path.join(directory, "skill.json")), true);
    assert.equal(existsSync(path.join(directory, "agents", "openai.yaml")), true);
    for (const resource of ["references", "scripts", "assets"]) assert.equal(existsSync(path.join(directory, resource)), true);
    assert.match(readFileSync(path.join(directory, "agents", "openai.yaml"), "utf8"), /\$create-report/);

    const unfinished = spawnSync(process.execPath, [
      path.resolve("skills/create-skill/scripts/validate-skill.mjs"),
      path.relative(root, directory)
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(unfinished.status, 0);
    assert.match(unfinished.stderr, /unfinished template placeholders/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-skill validator rejects direct package script commands and accepts Runtime script dispatch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-script-guidance-"));
  try {
    const directory = createSkill({ name: "scripted-skill", parent: root, scripts: true });
    writeFileSync(path.join(directory, "SKILL.md"), "---\nname: scripted-skill\ndescription: Validate a project with a declared script. Use when project validation is requested.\n---\n\n# Scripted Skill\n\nRun `node scripts/validate.mjs` from the project root.\n");
    const rejected = spawnSync(process.execPath, [
      path.resolve("skills/create-skill/scripts/validate-skill.mjs"),
      path.basename(directory)
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /run_skill_script/);

    writeFileSync(path.join(directory, "SKILL.md"), "---\nname: scripted-skill\ndescription: Validate a project with a declared script. Use when project validation is requested.\n---\n\n# Scripted Skill\n\nCall the top-level `run_skill_script` tool with this Skill's loaded `capabilityId` and scriptId `validate`.\n");
    const accepted = spawnSync(process.execPath, [
      path.resolve("skills/create-skill/scripts/validate-skill.mjs"),
      path.basename(directory)
    ], { cwd: root, encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-skill explicitly distinguishes Runtime installers from Skill scripts", () => {
  const instructions = readFileSync(path.resolve("skills/create-skill/SKILL.md"), "utf8");
  const manifest = JSON.parse(readFileSync(path.resolve("skills/create-skill/skill.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
    version: string;
  };
  assert.equal(manifest.version, "1.3.0");
  assert.deepEqual(Object.keys(manifest.scripts ?? {}).sort(), ["init", "pack", "validate"]);
  assert.match(instructions, /top-level Runtime tool `preview_skill_install` directly/);
  assert.match(instructions, /Never send either name to `run_skill_script`, `invoke_capability`, or `search_capabilities`/);
  assert.match(instructions, /must be restarted or updated/);
  assert.match(instructions, /workspaceKind` is `scratch`/);
  assert.match(instructions, /use `search_capabilities` with the exact Skill name to confirm discovery/);
});

test("declared Skill scripts reuse managed command completion, failure and stop states", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepcreator-skill-command-"));
  try {
    const builtin = path.join(root, "builtin");
    const project = path.join(root, "project");
    mkdirSync(project, { recursive: true });
    const directory = createSkill({
      name: "managed-script",
      parent: builtin,
      permissions: ["workspace_read", "workspace_write", "local_code_execution"],
      scriptPermissions: ["workspace_write", "local_code_execution"],
      scripts: true
    });
    const script = path.join(directory, "scripts", "validate.mjs");
    writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync('skill-output.txt', String(Boolean(process.env.OPENAI_API_KEY)));\n");
    let catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory: builtin, homeDirectory: path.join(root, "home") });
    let capabilityId = catalog.effective(project)[0].capabilityId;
    const completed = await executeTool({
      activityId: "activity_skill_complete",
      args: { capabilityId, scriptId: "validate" },
      commandCheckpointMs: 5_000,
      name: "run_skill_script",
      projectRoot: project,
      runId: "run_skill_complete",
      sessionId: "session_skill",
      skillCatalog: catalog
    });
    assert.equal(completed.commandState, "completed");
    assert.equal(completed.mutatedWorkspace, true);
    assert.equal(readFileSync(path.join(project, "skill-output.txt"), "utf8"), "false");

    writeFileSync(script, "process.exit(7);\n");
    catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory: builtin, homeDirectory: path.join(root, "home") });
    capabilityId = catalog.effective(project)[0].capabilityId;
    const failed = await executeTool({
      activityId: "activity_skill_failed",
      args: { capabilityId, scriptId: "validate" },
      commandCheckpointMs: 5_000,
      name: "run_skill_script",
      projectRoot: project,
      runId: "run_skill_failed",
      sessionId: "session_skill",
      skillCatalog: catalog
    });
    assert.equal(failed.commandState, "failed");
    assert.equal(failed.exitCode, 7);

    writeFileSync(script, "setInterval(() => undefined, 1000);\n");
    catalog = new SkillCatalog({ appVersion: "0.1.0", builtinDirectory: builtin, homeDirectory: path.join(root, "home") });
    capabilityId = catalog.effective(project)[0].capabilityId;
    const running = await executeTool({
      activityId: "activity_skill_running",
      args: { capabilityId, scriptId: "validate" },
      commandCheckpointMs: 500,
      name: "run_skill_script",
      projectRoot: project,
      runId: "run_skill_running",
      sessionId: "session_skill",
      skillCatalog: catalog
    });
    assert.equal(running.commandState, "running");
    const stopped = await executeTool({
      args: { commandId: running.commandId },
      name: "stop_command",
      projectRoot: project,
      skillCatalog: catalog
    });
    assert.equal(stopped.commandState, "cancelled");
  } finally {
    // Windows 下被终止的 node 进程句柄释放有延迟,EPERM 需重试(commandManager 测试同款模式)
    try {
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});
