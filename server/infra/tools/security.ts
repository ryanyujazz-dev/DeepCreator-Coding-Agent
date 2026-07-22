import path from "node:path";

export function ensureInsideRoot(projectRoot: string, targetPath = "."): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径必须位于项目根目录内。");
  }
  return resolved;
}

export function workspaceRelativeTarget(projectRoot: string, rawTarget: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, rawTarget || ".");
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return rawTarget;
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  return relative || ".";
}

export function isSensitivePath(targetPath: string): boolean {
  const base = path.basename(targetPath).toLowerCase();
  if (base === ".env.example") return false;
  return (
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === "credentials" ||
    base === "id_rsa" ||
    base.startsWith(".env") ||
    base.endsWith(".key") ||
    base.endsWith(".pem") ||
    base.includes("credentials") ||
    base.includes("secret")
  );
}

export function redactSensitiveText(text: string): string {
  let redacted = text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    redacted = redacted.split(value).join(`[REDACTED_${name}]`);
  }
  return redacted;
}
