import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { startRuntime } from "./runtime";

dotenv.config({ path: ".env.local" });

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../..");
const runtime = await startRuntime({
  apiKey: process.env.DEEPSEEK_API_KEY,
  authToken: process.env.RUNTIME_AUTH_TOKEN,
  dataDirectory: path.resolve(process.env.RUNTIME_DATA_DIR ?? path.join(workspaceRoot, ".deepseeker")),
  defaultModel: process.env.DEEPSEEK_MODEL,
  frontendUrl: process.env.FRONTEND_URL,
  host: "127.0.0.1",
  migrationDirectory: path.join(workspaceRoot, "server/infra/migrations"),
  port: Number(process.env.RUNTIME_PORT ?? 8787),
  runtimeMode: process.env.RUNTIME_MODE,
  workspaceRoot
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await runtime.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

console.log(`DeepSeeker Runtime listening on http://${runtime.host}:${runtime.port}`);
