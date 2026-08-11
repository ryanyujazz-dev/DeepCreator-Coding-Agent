import { builtinModules } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const allowedExternalModules = new Set([
  "electron",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function packageRoots(platform, architecture) {
  const outDirectory = path.resolve("out");
  if (!existsSync(outDirectory)) return [];
  const prefix = `DeepCreator-${platform}-`;
  return readdirSync(outDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .filter((entry) => !architecture || entry.name === `${prefix}${architecture}`)
    .map((entry) => path.join(outDirectory, entry.name));
}

function asarPath(packageRoot, platform) {
  return platform === "darwin"
    ? path.join(packageRoot, "DeepCreator.app", "Contents", "Resources", "app.asar")
    : path.join(packageRoot, "resources", "app.asar");
}

function externalRequires(source) {
  return [...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter((moduleName) => !moduleName.startsWith(".") && !allowedExternalModules.has(moduleName));
}

function packageName(moduleName) {
  const segments = moduleName.split("/");
  return moduleName.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function verifyAppAsar(filePath) {
  if (!existsSync(filePath)) throw new Error(`没有找到发布包：${filePath}`);
  const entries = new Set(listPackage(filePath));
  const entryPoints = [
    ".vite/build/main.js",
    ".vite/build/preload.js",
    ".vite/build/runtime-worker.js"
  ];
  const unresolved = new Map();
  for (const entryPoint of entryPoints) {
    if (!entries.has(`/${entryPoint}`)) throw new Error(`发布包缺少入口文件：${entryPoint}`);
    const source = extractFile(filePath, entryPoint).toString("utf8");
    const dependencies = [...new Set(externalRequires(source))];
    const missing = dependencies.filter((moduleName) => !entries.has(`/node_modules/${packageName(moduleName)}/package.json`));
    if (missing.length > 0) unresolved.set(entryPoint, missing);
  }
  if (unresolved.size > 0) {
    const detail = [...unresolved]
      .map(([entryPoint, dependencies]) => `${entryPoint}: ${dependencies.join(", ")}`)
      .join("\n");
    throw new Error(`发现未打包的第三方运行时依赖：\n${detail}`);
  }
  for (const requiredPackage of ["electron-squirrel-startup", "fastify", "update-electron-app"]) {
    if (!entries.has(`/node_modules/${requiredPackage}/package.json`)) {
      throw new Error(`发布包缺少必要运行时依赖：${requiredPackage}`);
    }
  }
  console.log(`发布包运行时依赖完整：${filePath}`);
}

const platform = option("platform");
const architecture = option("arch");
if (platform !== "darwin" && platform !== "win32") {
  throw new Error("必须使用 --platform=darwin 或 --platform=win32 指定发布平台。");
}
const roots = packageRoots(platform, architecture);
if (roots.length === 0) {
  throw new Error(`没有找到 DeepCreator-${platform}-${architecture ?? "*"} 发布目录。`);
}
for (const root of roots) verifyAppAsar(asarPath(root, platform));
