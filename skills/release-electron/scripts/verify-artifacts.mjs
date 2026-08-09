import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

function workspacePath(value) {
  const root = path.resolve(process.cwd());
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Artifact is outside the workspace: ${value}`);
  return target;
}

if (process.argv.length < 3) throw new Error("Usage: verify-artifacts.mjs <artifact> [...artifact]");
const hashes = new Map();
for (const value of process.argv.slice(2)) {
  const target = workspacePath(value);
  const info = statSync(target);
  if (!info.isFile() || info.size === 0) throw new Error(`Artifact is missing or empty: ${value}`);
  const hash = createHash("sha256").update(readFileSync(target)).digest("hex");
  const duplicate = hashes.get(hash);
  if (duplicate) throw new Error(`Artifacts have identical content: ${duplicate} and ${value}`);
  hashes.set(hash, value);
  process.stdout.write(`${value}\t${info.size} bytes\t${hash}\n`);
}
