import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureInsideRoot, isSensitivePath } from "./security";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".deepseeker",
  ".playwright-cli",
  ".pytest_cache",
  ".venv",
  "dist",
  "node_modules",
  "output"
]);

export async function listFiles(projectRoot: string, input: { maxFiles?: number }): Promise<string> {
  const root = ensureInsideRoot(projectRoot);
  const output: string[] = [];
  const maxFiles = Math.min(1000, Math.max(1, input.maxFiles ?? 200));
  async function walk(current: string): Promise<void> {
    if (output.length >= maxFiles) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (output.length >= maxFiles) return;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (!entry.isDirectory() && isSensitivePath(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else output.push(path.relative(root, fullPath));
    }
  }
  await walk(root);
  return output.join("\n") || "项目目录中没有文件。";
}

export async function readFile(projectRoot: string, input: { path: string; maxChars?: number }): Promise<string> {
  if (isSensitivePath(input.path)) throw new Error("出于安全原因，Runtime 不允许读取密钥或凭据文件。");
  const contents = await fs.readFile(ensureInsideRoot(projectRoot, input.path), "utf8");
  const maxChars = Math.min(200_000, Math.max(1, input.maxChars ?? 40_000));
  return contents.slice(0, maxChars);
}

export async function writeFile(projectRoot: string, input: { path: string; content: string }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existed = await fs.access(filePath).then(() => true).catch(() => false);
  await fs.writeFile(filePath, input.content, "utf8");
  return `${existed ? "已编辑" : "已创建"} ${input.path}`;
}

export async function editFile(
  projectRoot: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean }
): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const contents = await fs.readFile(filePath, "utf8");
  if (!input.oldText) throw new Error("oldText 不能为空。创建文件请使用 write_file。");
  const occurrences = contents.split(input.oldText).length - 1;
  if (occurrences === 0) throw new Error(`未在 ${input.path} 中找到 oldText。`);
  if (occurrences > 1 && !input.replaceAll) throw new Error(`oldText 在 ${input.path} 中出现 ${occurrences} 次，请提供更精确文本。`);
  const next = input.replaceAll ? contents.split(input.oldText).join(input.newText) : contents.replace(input.oldText, input.newText);
  await fs.writeFile(filePath, next, "utf8");
  return `已编辑 ${input.path}`;
}

export async function deleteFile(projectRoot: string, input: { path: string }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("delete_file 只能删除文件。");
  await fs.unlink(filePath);
  return `已删除 ${input.path}`;
}
