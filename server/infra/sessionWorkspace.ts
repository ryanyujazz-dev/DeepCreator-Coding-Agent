import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function scratchWorkspacePath(dataDirectory: string, sessionId: string): string {
  const directoryName = createHash("sha256").update(sessionId).digest("hex");
  return path.join(path.resolve(dataDirectory), "scratch-workspaces", directoryName);
}

export async function ensureScratchWorkspace(dataDirectory: string, sessionId: string): Promise<string> {
  const workspace = scratchWorkspacePath(dataDirectory, sessionId);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}
