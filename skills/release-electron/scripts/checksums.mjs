import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";

function workspacePath(value) {
  const root = path.resolve(process.cwd());
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Artifact is outside the workspace: ${value}`);
  return target;
}

async function checksum(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

if (process.argv.length < 3) throw new Error("Usage: checksums.mjs <artifact> [...artifact]");
for (const value of process.argv.slice(2)) {
  const target = workspacePath(value);
  if (!statSync(target).isFile()) throw new Error(`Not a file: ${value}`);
  process.stdout.write(`${await checksum(target)}  ${value.replaceAll("\\", "/")}\n`);
}
