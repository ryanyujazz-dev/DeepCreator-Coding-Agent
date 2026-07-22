export interface WorkspacePort {
  canonicalize(targetPath: string): string;
  ensureScratch(sessionId: string): Promise<string>;
  resolveProjectRoot(input: {
    explicitRoot?: string;
    fallbackRoot: string;
    prompt: string;
  }): Promise<string>;
}
