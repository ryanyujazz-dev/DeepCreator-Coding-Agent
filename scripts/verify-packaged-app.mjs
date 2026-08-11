import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const allowedExternalModules = new Set([
  "electron",
  "node:sqlite",
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

function executablePath(packageRoot, platform) {
  return platform === "darwin"
    ? path.join(packageRoot, "DeepCreator.app", "Contents", "MacOS", "DeepCreator")
    : path.join(packageRoot, "DeepCreator.exe");
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
  const entries = new Set(listPackage(filePath).map((entry) => entry.replaceAll("\\", "/")));
  const entryPoints = [
    ".vite/build/main.js",
    ".vite/build/preload.js",
    ".vite/build/runtime-worker.js"
  ];
  const unresolved = new Map();
  for (const entryPoint of entryPoints) {
    if (!entries.has(`/${entryPoint}`)) throw new Error(`发布包缺少入口文件：${entryPoint}`);
    const source = extractFile(filePath, path.normalize(entryPoint)).toString("utf8");
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

function verifyElectronNodeRuntime(filePath) {
  const probe = [
    'const { DatabaseSync } = require("node:sqlite")',
    'const database = new DatabaseSync(":memory:")',
    'database.exec("SELECT 1")',
    'database.close()',
    'process.stdout.write("DEEPCREATOR_SQLITE_READY")'
  ].join(";");
  const result = spawnSync(filePath, ["-e", probe], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error) throw new Error(`无法启动发布包 Node Runtime：${result.error.message}`);
  if (result.status !== 0 || !result.stdout.includes("DEEPCREATOR_SQLITE_READY")) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`发布包 Node Runtime 无法创建 SQLite 数据库：${detail || `退出码 ${result.status}`}`);
  }
  console.log(`发布包 SQLite Runtime 可用：${filePath}`);
}

function verifyMacDistribution(packageRoot) {
  const appPath = path.join(packageRoot, "DeepCreator.app");
  const commands = [
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]],
    ["spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]],
    ["xcrun", ["stapler", "validate", appPath]]
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    if (result.error || result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`macOS 签名或公证校验失败（${command}）：${detail || result.error?.message || `退出码 ${result.status}`}`);
    }
  }
  console.log(`macOS Developer ID 签名与公证票据有效：${appPath}`);
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
for (const root of roots) {
  verifyAppAsar(asarPath(root, platform));
  verifyElectronNodeRuntime(executablePath(root, platform));
  if (platform === "darwin" && process.env.DEEPCREATOR_REQUIRE_MAC_NOTARIZATION === "1") {
    verifyMacDistribution(root);
  }
}
