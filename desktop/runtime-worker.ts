import { startRuntime } from "../server/bootstrap/runtime";
import { ModelProtocol } from "../shared/contracts/provider";

type ParentMessageEvent = { data?: unknown };
type ParentPort = { on: (event: "message", listener: (event: ParentMessageEvent) => void) => void; postMessage: (message: unknown) => void };
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const sendToParent = (message: unknown): void => {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
};
const onParentMessage = (listener: (message: unknown) => void): void => {
  if (parentPort) {
    parentPort.on("message", (event) => listener(event.data));
  }
  else process.on("message", listener);
};

async function main(): Promise<void> {
  console.log(`[runtime-worker] started (type ${process.type ?? "node"}, Node ${process.versions.node}, parentPort ${parentPort ? "ready" : "missing"}).`);
  if (!parentPort && !process.send) throw new Error("Runtime Worker requires a parent IPC channel.");
  const evalsEnabled = import.meta.env.DEV && process.env.RUNTIME_EVALS_ENABLED === "1";
  const modelProtocols = process.env.DEEPSEEK_MODEL_PROTOCOLS
    ? JSON.parse(process.env.DEEPSEEK_MODEL_PROTOCOLS) as Record<string, ModelProtocol>
    : undefined;
  const runtime = await startRuntime({
    appVersion: process.env.DEEPCREATOR_APP_VERSION,
    apiKey: process.env.DEEPSEEK_API_KEY,
    authToken: process.env.RUNTIME_AUTH_TOKEN,
    builtinSkillDirectory: process.env.RUNTIME_BUILTIN_SKILLS_DIR,
    dataDirectory: process.env.RUNTIME_DATA_DIR!,
    defaultModel: process.env.DEEPSEEK_MODEL,
    modelProtocols,
    evalRepositoryRoot: process.env.RUNTIME_EVAL_REPOSITORY_ROOT,
    evalServiceFactory: evalsEnabled ? async (deps) => {
      const { EvalService } = await import("../server/dev-evals/evalService");
      return new EvalService(deps);
    } : undefined,
    frontendUrl: process.env.RUNTIME_FRONTEND_URL ?? "file://",
    globalSkillDirectory: process.env.RUNTIME_GLOBAL_SKILLS_DIR,
    host: "127.0.0.1",
    migrationDirectory: process.env.RUNTIME_MIGRATIONS_DIR,
    port: 0,
    runtimeMode: process.env.RUNTIME_MODE,
    skillRegistryFile: process.env.RUNTIME_SKILL_REGISTRY_FILE,
    skillPreviewDirectory: process.env.RUNTIME_SKILL_PREVIEW_DIR,
    workspaceRoot: process.env.RUNTIME_WORKSPACE_ROOT ?? process.cwd(),
    zhipuApiKey: process.env.ZHIPU_API_KEY
  });
  sendToParent({ port: runtime.port, type: "ready" });
  onParentMessage((message) => {
    if ((message as { type?: string })?.type !== "shutdown") return;
    void runtime.close().finally(() => {
      sendToParent({ type: "stopped" });
      process.exit(0);
    });
  });
}

void main().catch((error) => {
  sendToParent({ error: error instanceof Error ? error.message : String(error), type: "failed" });
  process.exit(1);
});
