import path from "node:path";
import { SkillInstallPreview, SkillInstallScope } from "../../../shared/contracts/skill";
import { ToolResult } from "../../../shared/contracts/tool";
import { SkillStore } from "../skillStore";

export type SkillInstallConfirmation = {
  displayName: string;
  name: string;
  permissions: string[];
  previewId: string;
  publisher: string;
  revisionHash: string;
  scope: SkillInstallScope;
  scripts: string[];
  source: string;
  version: string;
};

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function installSource(preview: SkillInstallPreview): string {
  return preview.source.kind === "github" ? preview.source.releaseUrl : preview.source.label;
}

function normalizedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function confirmation(preview: SkillInstallPreview, scope: SkillInstallScope): SkillInstallConfirmation {
  return {
    displayName: preview.displayName,
    name: preview.name,
    permissions: [...preview.permissions].sort(),
    previewId: preview.previewId,
    publisher: preview.publisher,
    revisionHash: preview.revisionHash,
    scope,
    scripts: preview.scripts.map((script) => script.id).sort(),
    source: installSource(preview),
    version: preview.version
  };
}

function requireScope(value: unknown): SkillInstallScope {
  if (value === "global" || value === "project") return value;
  throw new Error("Skill 安装范围必须是 global 或 project。");
}

function assertConfirmation(preview: SkillInstallPreview, args: Record<string, unknown>): SkillInstallConfirmation {
  const expected = confirmation(preview, requireScope(args.scope));
  const received: SkillInstallConfirmation = {
    displayName: String(args.displayName ?? ""),
    name: String(args.name ?? ""),
    permissions: normalizedStrings(args.permissions),
    previewId: String(args.previewId ?? ""),
    publisher: String(args.publisher ?? ""),
    revisionHash: String(args.revisionHash ?? ""),
    scope: requireScope(args.scope),
    scripts: normalizedStrings(args.scripts),
    source: String(args.source ?? ""),
    version: String(args.version ?? "")
  };
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error("安装确认信息与安全预览不一致，请重新生成预览，不能复用或修改确认参数。");
  }
  return expected;
}

export async function previewSkillInstall(input: {
  args: Record<string, unknown>;
  projectRoot: string;
  store: SkillStore;
}): Promise<ToolResult> {
  const rawSource = String(input.args.source ?? "").trim();
  if (!rawSource) throw new Error("必须提供 Skill 文件夹、安装包或公开 GitHub Release 地址。");
  if (input.args.scope === undefined) throw new Error("必须明确选择 Skill 安装范围：project 或 global。");
  const scope = requireScope(input.args.scope);
  const preview = /^https:\/\//i.test(rawSource)
    ? await input.store.previewGitHub(rawSource)
    : (() => {
        const source = path.resolve(input.projectRoot, rawSource);
        if (!isInside(input.projectRoot, source)) throw new Error("Agent 只能从当前工作区内发起本地 Skill 安装预览。");
        return input.store.previewLocal(source);
      })();
  return {
    mutatedWorkspace: false,
    output: JSON.stringify({
      installRequest: confirmation(preview, scope),
      preview
    }, null, 2)
  };
}

export function installSkill(input: {
  args: Record<string, unknown>;
  projectRoot: string;
  store: SkillStore;
}): ToolResult {
  const previewId = String(input.args.previewId ?? "");
  const preview = input.store.preview(previewId);
  const confirmed = assertConfirmation(preview, input.args);
  const skills = input.store.install({
    previewId,
    projectRoot: confirmed.scope === "project" ? input.projectRoot : undefined,
    scope: confirmed.scope,
    trusted: true
  });
  const installed = skills.find((skill) => skill.name === confirmed.name && skill.origin === confirmed.scope);
  if (!installed) throw new Error(`Skill 已写入，但无法在 ${confirmed.scope} 范围重新发现：${confirmed.name}`);
  return {
    mutatedWorkspace: confirmed.scope === "project",
    output: JSON.stringify({
      installed: {
        capabilityId: installed.capabilityId,
        enabled: installed.enabled,
        name: installed.name,
        origin: installed.origin,
        publisher: installed.publisher,
        revisionHash: installed.revisionHash,
        trusted: installed.trusted,
        version: installed.version
      }
    }, null, 2)
  };
}
