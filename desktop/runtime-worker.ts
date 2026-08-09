import { startRuntime } from "../server/bootstrap/runtime";
import { ModelProtocol } from "../shared/contracts/provider";

type ParentPort = { on: (event: "message", listener: (message: unknown) => void) => void; postMessage: (message: unknown) => void };
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

async function main(): Promise<void> {
  if (!parentPort) throw new Error("Runtime Worker requires an Electron parent port.");
  const evalsEnabled = import.meta.env.DEV && process.env.RUNTIME_EVALS_ENABLED === "1";
  const modelProtocols = process.env.DEEPSEEK_MODEL_PROTOCOLS
    ? JSON.parse(process.env.DEEPSEEK_MODEL_PROTOCOLS) as Record<string, ModelProtocol>
    : undefined;
  const runtime = await startRuntime({
    apiKey: process.env.DEEPSEEK_API_KEY,
    authToken: process.env.RUNTIME_AUTH_TOKEN,
    dataDirectory: process.env.RUNTIME_DATA_DIR!,
    defaultModel: process.env.DEEPSEEK_MODEL,
    modelProtocols,
    evalRepositoryRoot: process.env.RUNTIME_EVAL_REPOSITORY_ROOT,
    evalServiceFactory: evalsEnabled ? async (deps) => {
      const { EvalService } = await import("../server/dev-evals/evalService");
      return new EvalService(deps);
    } : undefined,
    frontendUrl: process.env.RUNTIME_FRONTEND_URL ?? "file://",
    host: "127.0.0.1",
    migrationDirectory: process.env.RUNTIME_MIGRATIONS_DIR,
    port: 0,
    runtimeMode: process.env.RUNTIME_MODE,
    workspaceRoot: process.env.RUNTIME_WORKSPACE_ROOT ?? process.cwd(),
    zhipuApiKey: process.env.ZHIPU_API_KEY
  });
  parentPort.postMessage({ port: runtime.port, type: "ready" });
  parentPort.on("message", (message) => {
    if ((message as { type?: string })?.type !== "shutdown") return;
    void runtime.close().finally(() => {
      parentPort.postMessage({ type: "stopped" });
      process.exit(0);
    });
  });
}

void main().catch((error) => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error), type: "failed" });
  process.exit(1);
});
