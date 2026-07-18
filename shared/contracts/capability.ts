export interface CapabilitySource {
  digest(projectRoot: string, limit?: number): string;
}

export const emptyCapabilitySource: CapabilitySource = {
  digest: () => "No deferred skills or MCP capabilities are currently indexed."
};
