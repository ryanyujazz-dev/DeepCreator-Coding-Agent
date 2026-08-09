import { createHash } from "node:crypto";
import { CapabilitySource } from "../../shared/contracts/capability";
import { systemReminder } from "../../shared/domain/context";
import { SkillCatalog, defaultSkillCatalog } from "./skillCatalog";

export type DeferredCapability = {
  capabilityId: string;
  description: string;
  kind: "skill" | "mcp_tool";
  name: string;
  origin?: "builtin" | "global" | "project";
  permissions?: string[];
  publisher?: string;
  revisionHash: string;
  source: string;
  version?: string;
};

type LoadedCapability = DeferredCapability & { body?: string; providerId?: string };

export type DeferredCapabilityProvider = {
  providerId: string;
  list(projectRoot: string): DeferredCapability[];
  invoke(input: { capabilityId: string; arguments: Record<string, unknown>; projectRoot: string; signal?: AbortSignal }): Promise<{ output: string }>;
};

const providers = new Map<string, DeferredCapabilityProvider>();

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function registerDeferredCapabilityProvider(provider: DeferredCapabilityProvider): () => void {
  providers.set(provider.providerId, provider);
  return () => providers.delete(provider.providerId);
}

function loadedCapabilities(projectRoot: string, catalog: SkillCatalog): LoadedCapability[] {
  return [
    ...catalog.effective(projectRoot).map((skill) => ({
      body: skill.body,
      capabilityId: skill.capabilityId,
      description: skill.description,
      kind: "skill" as const,
      name: skill.name,
      origin: skill.origin,
      permissions: skill.permissions,
      publisher: skill.publisher,
      revisionHash: skill.revisionHash,
      source: skill.source,
      version: skill.version
    })),
    ...[...providers.values()].flatMap((provider) => provider.list(projectRoot).map((capability) => ({ ...capability, providerId: provider.providerId })))
  ];
}

export function listDeferredCapabilities(projectRoot: string, catalog = defaultSkillCatalog): LoadedCapability[] {
  return loadedCapabilities(projectRoot, catalog);
}

export function capabilityDigest(projectRoot: string, limit = 30, catalog = defaultSkillCatalog): string {
  const capabilities = loadedCapabilities(projectRoot, catalog).slice(0, limit);
  if (capabilities.length === 0) return "当前没有已建立索引的延迟 Skill 或 MCP 能力。";
  return capabilities.map(({ capabilityId, description, kind, name, origin, version }) =>
    `${capabilityId}\t${kind}\t${name}\t${description}${origin ? `\t${origin}\t${version ?? "0.0.0"}` : ""}`
  ).join("\n");
}

export function searchCapabilities(projectRoot: string, query: string, limit = 10, catalog = defaultSkillCatalog): DeferredCapability[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return loadedCapabilities(projectRoot, catalog)
    .filter((capability) => terms.length === 0 || terms.every((term) => `${capability.name} ${capability.description}`.toLowerCase().includes(term)))
    .slice(0, Math.min(20, Math.max(1, limit)))
    .map(({ body: _body, providerId: _providerId, ...capability }) => capability);
}

export async function invokeCapability(
  projectRoot: string,
  capabilityId: string,
  argumentsValue: Record<string, unknown> = {},
  signal?: AbortSignal,
  catalog = defaultSkillCatalog
): Promise<{ capability: DeferredCapability; contextUpdate?: string; output?: string }> {
  const capabilities = loadedCapabilities(projectRoot, catalog);
  const requestedSkillName = capabilityId.match(/^skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?::[a-f0-9]{12,64})?$/)?.[1];
  const match = capabilities.find((capability) => capability.capabilityId === capabilityId)
    ?? (requestedSkillName
      ? capabilities.find((capability) => capability.kind === "skill" && capability.name === requestedSkillName)
      : undefined);
  if (!match) throw new Error(`未找到能力：${capabilityId}`);
  const { body, providerId, ...capability } = match;
  if (providerId) {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`能力 Provider 已卸载：${providerId}`);
    const result = await provider.invoke({ arguments: argumentsValue, capabilityId, projectRoot, signal });
    return {
      capability,
      contextUpdate: systemReminder("guidance", `kind="capability_loaded" capability_id="${escapeXmlAttribute(capability.capabilityId)}" revision="${capability.revisionHash}"\n能力 ${capability.name} 已按需调用，结果位于相邻的配对工具结果中。本记录仅用于审计能力启用过程。`),
      output: result.output
    };
  }
  if (capability.kind !== "skill" || !body) return { capability };
  const maxChars = Number(process.env.DEEPSEEK_SKILL_MAX_CHARS ?? 40_000);
  return {
    capability,
    contextUpdate: systemReminder("guidance", `kind="skill" capability_id="${escapeXmlAttribute(capability.capabilityId)}" revision="${capability.revisionHash}"\n${JSON.stringify({ instructions: body.slice(0, maxChars) })}`)
  };
}

export function createCapabilitySource(catalog: SkillCatalog): CapabilitySource {
  return { digest: (projectRoot, limit) => capabilityDigest(projectRoot, limit, catalog) };
}

export function capabilityIdFor(name: string, content: string): string {
  return `skill:${name}:${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
}

export const capabilitySource: CapabilitySource = createCapabilitySource(defaultSkillCatalog);
