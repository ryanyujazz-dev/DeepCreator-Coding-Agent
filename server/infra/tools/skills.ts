import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { SkillCatalog } from "../skillCatalog";
import { quoteRuntimeShellArgument } from "../shell";
import { ensureInsideRoot } from "./security";

export function readSkillResource(
  catalog: SkillCatalog,
  projectRoot: string,
  args: { capabilityId?: unknown; path?: unknown; maxChars?: unknown }
): string {
  const capabilityId = String(args.capabilityId ?? "").trim();
  const resourcePath = String(args.path ?? "").trim();
  if (!capabilityId || !resourcePath) throw new Error("capabilityId 和 path 不能为空。");
  const maxChars = Math.min(200_000, Math.max(1, Number(args.maxChars ?? 80_000)));
  return catalog.readReference(projectRoot, capabilityId, resourcePath, maxChars);
}

export function materializeSkillAsset(
  catalog: SkillCatalog,
  projectRoot: string,
  args: { capabilityId?: unknown; path?: unknown; target?: unknown; overwrite?: unknown }
): string {
  const capabilityId = String(args.capabilityId ?? "").trim();
  const assetPath = String(args.path ?? "").trim();
  const targetPath = String(args.target ?? "").trim();
  if (!capabilityId || !assetPath || !targetPath) throw new Error("capabilityId、path 和 target 不能为空。");
  const source = catalog.assetPath(projectRoot, capabilityId, assetPath);
  const target = ensureInsideRoot(projectRoot, targetPath);
  let cursor = path.resolve(projectRoot);
  for (const segment of path.relative(cursor, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`目标路径不能经过符号链接：${targetPath}`);
    }
  }
  if (existsSync(target) && !args.overwrite) throw new Error(`目标文件已存在：${targetPath}`);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.deepcreator-skill-${randomUUID()}`;
  const backup = `${target}.deepcreator-skill-backup-${randomUUID()}`;
  let backedUp = false;
  try {
    copyFileSync(source, temporary);
    if (existsSync(target)) {
      renameSync(target, backup);
      backedUp = true;
    }
    renameSync(temporary, target);
    if (backedUp) rmSync(backup, { force: true });
    return `已从 Skill 资源创建 ${path.relative(projectRoot, target).split(path.sep).join("/")}（${statSync(target).size} 字节）。`;
  } catch (error) {
    rmSync(temporary, { force: true });
    if (backedUp && existsSync(backup)) {
      rmSync(target, { force: true });
      renameSync(backup, target);
    }
    throw error;
  }
}

export function skillScriptCommand(
  catalog: SkillCatalog,
  projectRoot: string,
  args: { capabilityId?: unknown; scriptId?: unknown; args?: unknown }
): { command: string; env: NodeJS.ProcessEnv; mutatesWorkspace: boolean } {
  const capabilityId = String(args.capabilityId ?? "").trim();
  const scriptId = String(args.scriptId ?? "").trim();
  if (!capabilityId || !scriptId) throw new Error("capabilityId 和 scriptId 不能为空。");
  if (args.args !== undefined && !Array.isArray(args.args)) throw new Error("args 必须是字符串数组。");
  const scriptArgs = (args.args ?? []).map((value: unknown) => String(value));
  if (scriptArgs.length > 100 || scriptArgs.some((value: string) => value.length > 8_192)) throw new Error("Skill 脚本参数超过限制。");
  const resolved = catalog.script(projectRoot, capabilityId, scriptId);
  const command = [process.execPath, resolved.path, ...scriptArgs].map(quoteRuntimeShellArgument).join(" ");
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "ComSpec", "COMSPEC"
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    command,
    env,
    mutatesWorkspace: resolved.script.permissions.some((permission) => permission === "workspace_write" || permission === "workspace_delete")
  };
}
