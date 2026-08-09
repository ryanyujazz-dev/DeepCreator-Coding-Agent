import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./runtime";
import { loadUserConfig } from "../infra/userConfig";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../..");

function defaultDataDirectory(): string {
  const target = path.join(workspaceRoot, ".deepcreator");
  const previous = path.join(workspaceRoot, ".deepseeker");
  if (!existsSync(target) && existsSync(previous)) {
    cpSync(previous, target, { errorOnExist: false, force: false, recursive: true });
  }
  return target;
}

async function main(): Promise<void> {
  const userConfig = loadUserConfig();
  const evalsEnabled = process.env.DEEPCREATOR_EVALS !== "0" && process.env.NODE_ENV !== "production";
  const runtime = await startRuntime({
    appVersion: "0.1.0",
    apiKey: process.env.DEEPSEEK_API_KEY ?? userConfig.apiKey,
    authToken: process.env.RUNTIME_AUTH_TOKEN,
    builtinSkillDirectory: path.join(workspaceRoot, "skills"),
    dataDirectory: path.resolve(process.env.RUNTIME_DATA_DIR ?? defaultDataDirectory()),
    defaultModel: process.env.DEEPSEEK_MODEL ?? userConfig.model,
    modelProtocols: userConfig.modelProtocols,
    evalRepositoryRoot: workspaceRoot,
    evalServiceFactory: evalsEnabled ? async (deps) => {
      const { EvalService } = await import("../dev-evals/evalService");
      return new EvalService(deps);
    } : undefined,
    frontendUrl: process.env.FRONTEND_URL,
    host: "127.0.0.1",
    migrationDirectory: path.join(workspaceRoot, "server/infra/migrations"),
    port: Number(process.env.RUNTIME_PORT ?? 8787),
    runtimeMode: process.env.RUNTIME_MODE,
    workspaceRoot,
    zhipuApiKey: process.env.ZHIPU_API_KEY ?? userConfig.zhipuApiKey
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };

  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  console.log(`DeepCreator Runtime listening on http://${runtime.host}:${runtime.port}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
