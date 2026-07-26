import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./runtime";
import { loadUserConfig } from "../infra/userConfig";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../..");

async function main(): Promise<void> {
  const userConfig = loadUserConfig();
  const runtime = await startRuntime({
    apiKey: process.env.DEEPSEEK_API_KEY ?? userConfig.apiKey,
    authToken: process.env.RUNTIME_AUTH_TOKEN,
    dataDirectory: path.resolve(process.env.RUNTIME_DATA_DIR ?? path.join(workspaceRoot, ".deepseeker")),
    defaultModel: process.env.DEEPSEEK_MODEL ?? userConfig.model,
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
  console.log(`DeepSeeker Runtime listening on http://${runtime.host}:${runtime.port}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
