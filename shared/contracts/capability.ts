export interface CapabilitySource {
  digest(projectRoot: string, limit?: number): string;
}

export const emptyCapabilitySource: CapabilitySource = {
  digest: () => "当前没有已建立索引的延迟 Skill 或 MCP 能力。"
};
