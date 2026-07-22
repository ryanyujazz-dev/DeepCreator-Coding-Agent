import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { CapabilitySource } from "../../shared/contracts/capability";
import { systemReminder } from "../../shared/domain/context";

export type DeferredCapability = {
  capabilityId: string;
  kind: "skill" | "mcp_tool";
  name: string;
  description: string;
  revisionHash: string;
  source: string;
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

function parseSkill(source: string): LoadedCapability | undefined {
  const raw = readFileSync(source, "utf8").trim();
  if (!raw) return undefined;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let body = raw;
  let metadata: Record<string, unknown> = {};
  if (match) {
    const document = parseDocument(match[1]);
    if (document.errors.length > 0) return undefined;
    const value = document.toJS();
    if (value && typeof value === "object" && !Array.isArray(value)) metadata = value as Record<string, unknown>;
    body = raw.slice(match[0].length).trim();
  }
  const directoryName = path.basename(path.dirname(source));
  const name = String(metadata.name ?? directoryName);
  const description = String(metadata.description ?? body.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "Project skill").slice(0, 240);
  const revisionHash = createHash("sha256").update(raw).digest("hex");
  return { body, capabilityId: `skill:${name}:${revisionHash.slice(0, 12)}`, description, kind: "skill", name, revisionHash, source };
}

function collectSkillFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") return [target];
    if (entry.isDirectory()) {
      const skill = path.join(target, "SKILL.md");
      return existsSync(skill) ? [skill] : [];
    }
    return [];
  }).sort();
}

export function listDeferredCapabilities(projectRoot: string): LoadedCapability[] {
  const files = [
    ...collectSkillFiles(path.join(homedir(), ".deepseeker", "skills")),
    ...collectSkillFiles(path.join(projectRoot, ".deepseeker", "skills"))
  ];
  return [
    ...files.flatMap((source) => parseSkill(source) ?? []),
    ...[...providers.values()].flatMap((provider) => provider.list(projectRoot).map((capability) => ({ ...capability, providerId: provider.providerId })))
  ];
}

export function capabilityDigest(projectRoot: string, limit = 30): string {
  const capabilities = listDeferredCapabilities(projectRoot).slice(0, limit);
  if (capabilities.length === 0) return "No deferred skills or MCP capabilities are currently indexed.";
  return capabilities.map(({ capabilityId, description, kind, name }) => `${capabilityId}\t${kind}\t${name}\t${description}`).join("\n");
}

export function searchCapabilities(projectRoot: string, query: string, limit = 10): DeferredCapability[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listDeferredCapabilities(projectRoot)
    .filter((capability) => terms.length === 0 || terms.every((term) => `${capability.name} ${capability.description}`.toLowerCase().includes(term)))
    .slice(0, Math.min(20, Math.max(1, limit)))
    .map(({ body: _body, providerId: _providerId, ...capability }) => capability);
}

export async function invokeCapability(
  projectRoot: string,
  capabilityId: string,
  argumentsValue: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<{ capability: DeferredCapability; contextUpdate?: string; output?: string }> {
  const match = listDeferredCapabilities(projectRoot).find((capability) => capability.capabilityId === capabilityId);
  if (!match) throw new Error(`未找到能力：${capabilityId}`);
  const { body, providerId, ...capability } = match;
  if (providerId) {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`能力 Provider 已卸载：${providerId}`);
    const result = await provider.invoke({ arguments: argumentsValue, capabilityId, projectRoot, signal });
    return {
      capability,
      contextUpdate: systemReminder("guidance", `kind="capability_loaded" capability_id="${escapeXmlAttribute(capability.capabilityId)}" revision="${capability.revisionHash}"\nCapability ${capability.name} has been invoked on demand. The result is in the adjacent paired tool result; this record is only for capability activation auditing.`),
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

export const capabilitySource: CapabilitySource = {
  digest: capabilityDigest
};
