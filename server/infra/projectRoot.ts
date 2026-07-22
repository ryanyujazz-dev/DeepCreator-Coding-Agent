import { promises as fs } from "node:fs";
import path from "node:path";

async function existingDirectory(candidate: string): Promise<string | undefined> {
  try {
    const resolved = path.resolve(candidate);
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProjectRoot(input: {
  explicitRoot?: string;
  fallbackRoot: string;
  prompt: string;
}): Promise<string> {
  if (input.explicitRoot?.trim()) {
    return (await existingDirectory(input.explicitRoot.trim())) ?? path.resolve(input.fallbackRoot);
  }

  const prompt = input.prompt.trimStart();
  if (!path.isAbsolute(prompt)) return path.resolve(input.fallbackRoot);
  for (let end = prompt.length; end > 1; end -= 1) {
    const candidate = prompt.slice(0, end).trimEnd();
    const directory = await existingDirectory(candidate);
    if (directory) return directory;
  }
  return path.resolve(input.fallbackRoot);
}
