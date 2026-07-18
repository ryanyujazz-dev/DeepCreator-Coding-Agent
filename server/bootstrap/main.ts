import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { RunRegistry } from "../app/runRegistry";
import { RuntimeStore } from "../infra/runtimeStore";
import { Runner } from "../app/runner";
import { DeepSeekProvider } from "../infra/deepseek";
import { MockProvider } from "../infra/mock";
import { resolveProjectRoot } from "../infra/projectRoot";
import { toolHost } from "../infra/tools";
import { capabilitySource } from "../infra/capabilities";
import { ruleSource } from "../infra/rules";
import { contextConfig } from "../infra/contextConfig";
import { createHttp } from "../transport/http";

dotenv.config({ path: ".env.local" });

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../..");
const dataDirectory = path.resolve(process.env.RUNTIME_DATA_DIR ?? path.join(workspaceRoot, ".deepseeker"));
const port = Number(process.env.RUNTIME_PORT ?? 8787);
const defaultModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const runtimeMode = process.env.RUNTIME_MODE;
const context = contextConfig();

const store = new RuntimeStore(dataDirectory);
const registry = new RunRegistry();
const runner = new Runner(toolHost, ruleSource, capabilitySource, context);
const app = createHttp({
  capabilities: capabilitySource,
  config: {
    dataDirectory,
    context,
    defaultModel,
    frontendUrl: process.env.FRONTEND_URL ?? "http://127.0.0.1:5173/",
    hasApiKey: Boolean(apiKey),
    workspaceRoot
  },
  providerFor(model) {
    const mock = model === "mock-agent" || runtimeMode === "mock" || !apiKey;
    return mock
      ? { model: "mock-agent", provider: new MockProvider() }
      : { model, provider: new DeepSeekProvider(apiKey) };
  },
  registry,
  resolveProjectRoot,
  rules: ruleSource,
  run: (input) => runner.run(input),
  store,
  tools: toolHost.specs
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  app.server.closeAllConnections();
  await app.close().catch(() => undefined);
  store.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: "127.0.0.1", port });
console.log(`DeepSeeker Runtime listening on http://127.0.0.1:${port}`);
