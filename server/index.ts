import "dotenv/config";
import dotenv from "dotenv";
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStreamMessage } from "../shared/agentTypes";
import { runDeepSeekAgent } from "./deepseekAdapter";
import { RunStore } from "./eventStore";
import { runMockAgent } from "./mockAgent";

dotenv.config({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const port = Number(process.env.RUNTIME_PORT ?? 8787);
const defaultModel = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const store = new RunStore();
const activeRuns = new Map<string, AbortController>();
const app = Fastify({
  logger: false
});

function writeSSE(raw: NodeJS.WritableStream, message: RunStreamMessage): void {
  raw.write(`data: ${JSON.stringify(message)}\n\n`);
}

app.get("/api/health", async () => ({
  ok: true,
  service: "deepseeker-runtime"
}));

app.get("/api/config", async () => ({
  defaultModel,
  hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY)
}));

app.post<{
  Body: {
    model?: string;
    projectRoot?: string;
    prompt?: string;
  };
}>("/api/runs", async (request, reply) => {
  const prompt = request.body.prompt?.trim();
  if (!prompt) {
    return reply.code(400).send({ error: "prompt is required" });
  }

  const projectRoot = path.resolve(request.body.projectRoot ?? workspaceRoot);
  const run = store.createRun({
    id: `run_${Date.now().toString(36)}`,
    model: request.body.model ?? defaultModel,
    projectRoot,
    prompt
  });

  const abortController = new AbortController();
  activeRuns.set(run.id, abortController);

  const shouldUseMock = run.model === "mock-agent" || process.env.RUNTIME_MODE === "mock";
  const runner = shouldUseMock
    ? runMockAgent({
        projectRoot,
        prompt,
        runId: run.id,
        signal: abortController.signal,
        store
      })
    : runDeepSeekAgent({
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        model: run.model,
        projectRoot,
        prompt,
        runId: run.id,
        signal: abortController.signal,
        store
      });

  void runner
    .catch((error) => {
      if (abortController.signal.aborted) {
        store.cancelRun(run.id);
        return;
      }
      store.failRun(run.id, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      activeRuns.delete(run.id);
    });

  return reply.send({ run });
});

app.get<{
  Params: {
    runId: string;
  };
}>("/api/runs/:runId", async (request, reply) => {
  const run = store.getRun(request.params.runId);
  if (!run) return reply.code(404).send({ error: "run not found" });
  return reply.send({ run });
});

app.get<{
  Params: {
    runId: string;
  };
}>("/api/runs/:runId/events", async (request, reply) => {
  const run = store.getRun(request.params.runId);
  if (!run) {
    return reply.code(404).send({ error: "run not found" });
  }

  reply.raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no"
  });

  const unsubscribe = store.subscribe(request.params.runId, (snapshot) => {
    writeSSE(reply.raw, {
      run: snapshot,
      type: "snapshot"
    });
  });

  request.raw.on("close", unsubscribe);
});

app.post<{
  Params: {
    runId: string;
  };
}>("/api/runs/:runId/cancel", async (request, reply) => {
  activeRuns.get(request.params.runId)?.abort();
  store.cancelRun(request.params.runId);
  return reply.send({ ok: true });
});

app.listen({ host: "127.0.0.1", port }).then(() => {
  console.log(`DeepSeeker runtime listening on http://127.0.0.1:${port}`);
});
