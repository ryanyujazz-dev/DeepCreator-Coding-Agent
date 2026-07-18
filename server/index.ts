import "dotenv/config";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";
import { ApprovalDecision, PermissionProfileKey, SignalStreamMessage, WorkspaceSessionView } from "../shared/runtimeTypes";
import { MemoryFact } from "./contextRecords";
import { runAgentCycle } from "./agentRuntime";
import { capabilityDigest } from "./capabilityIndex";
import { settleWorkCycle } from "./cycleLifecycle";
import { getCompactThresholdTokens, getContextWindowTokens, getEffectiveInputBudgetTokens, getRequestedMaxOutputTokens, prepareSessionContext } from "./contextManager";
import { DeepSeekProvider } from "./deepseekProvider";
import { LiveRegistry } from "./liveRegistry";
import { MockProvider } from "./mockProvider";
import { resolveInitialProjectRoot } from "./projectRootResolver";
import { SignalStore } from "./signalStore";
import { runtimeToolDefinitions } from "./tools";

dotenv.config({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const dataDirectory = path.resolve(process.env.RUNTIME_DATA_DIR ?? path.join(workspaceRoot, ".deepseeker"));
const port = Number(process.env.RUNTIME_PORT ?? 8787);
const frontendUrl = process.env.FRONTEND_URL ?? "http://127.0.0.1:5173/";
const defaultModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const store = new SignalStore(dataDirectory);
const registry = new LiveRegistry();
const app = Fastify({ logger: false });

function createContextPreview(): ReturnType<typeof prepareSessionContext>["telemetry"] {
  const now = new Date().toISOString();
  const session: WorkspaceSessionView = {
    compactThresholdTokens: getCompactThresholdTokens(),
    contextTokenEstimate: 0,
    contextWindowTokens: getContextWindowTokens(),
    createdAt: now,
    cycleKeys: [],
    cycles: [],
    lastOffset: 0,
    model: defaultModel,
    permissionGrants: [],
    permissionProfile: "request_approval",
    projectRoot: workspaceRoot,
    sessionKey: "context_preview",
    title: "Context preview",
    updatedAt: now
  };
  return prepareSessionContext({
    capabilityIndex: capabilityDigest(workspaceRoot),
    currentCycleKey: "context_preview",
    memoryIndex: store.memoryDigest(workspaceRoot),
    model: defaultModel,
    projectRoot: workspaceRoot,
    prompt: "",
    records: [],
    session,
    tokenCalibrationFactor: store.readTokenCalibrationFactor(defaultModel),
    tools: runtimeToolDefinitions
  }).telemetry;
}

function ensureInsideRoot(projectRoot: string, targetPath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径必须位于项目根目录内。");
  }
  return resolved;
}

function writeSSE(raw: NodeJS.WritableStream, message: SignalStreamMessage): void {
  raw.write(`data: ${JSON.stringify(message)}\n\n`);
}

app.get("/api/health", async () => ({ ok: true, service: "deepseeker-runtime", storage: dataDirectory }));

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${frontendUrl}" />
    <title>DeepSeeker Runtime</title>
  </head>
  <body>
    <p>DeepSeeker Runtime 正在运行。正在打开前端：<a href="${frontendUrl}">${frontendUrl}</a></p>
  </body>
</html>`);
});

app.get("/api/config", async () => ({
  compactThresholdTokens: getCompactThresholdTokens(),
  contextWindowTokens: getContextWindowTokens(),
  effectiveInputBudgetTokens: getEffectiveInputBudgetTokens(),
  requestedMaxOutputTokens: getRequestedMaxOutputTokens(),
  contextPreview: createContextPreview(),
  defaultModel,
  hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY),
  signalContract: "deepseeker.flow/v1"
}));

app.get<{ Querystring: { query?: string } }>("/api/sessions", async (request) => ({
  sessions: store.listSessions(request.query.query ?? "")
}));

const sessionParamsSchema = {
  params: {
    type: "object",
    properties: { sessionKey: { type: "string", minLength: 1 } },
    required: ["sessionKey"]
  }
};

const cycleParamsSchema = {
  params: {
    type: "object",
    properties: { cycleKey: { type: "string", minLength: 1 } },
    required: ["cycleKey"]
  }
};

const createCycleSchema = {
  body: {
    type: "object",
    properties: {
      model: { type: "string", minLength: 1 },
      projectRoot: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      permissionProfile: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] },
      sessionKey: { type: "string", minLength: 1 }
    }
  }
};

const signalQuerySchema = {
  params: {
    type: "object",
    properties: { sessionKey: { type: "string", minLength: 1 } },
    required: ["sessionKey"]
  },
  querystring: {
    type: "object",
    properties: { afterOffset: { type: "string", pattern: "^\\d+$" } }
  }
};

const cancelCycleSchema = { params: { ...cycleParamsSchema.params } };

const approvalSchema = {
  params: {
    type: "object",
    properties: { approvalKey: { type: "string", minLength: 1 } },
    required: ["approvalKey"]
  },
  body: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["allow_once", "allow_cycle", "allow_session", "deny"] }
    },
    required: ["decision"]
  }
};

app.get<{ Params: { sessionKey: string } }>("/api/sessions/:sessionKey", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { session };
});

app.get<{ Params: { sessionKey: string } }>("/api/sessions/:sessionKey/context-telemetry", { schema: sessionParamsSchema }, async (request, reply) => {
  if (!store.getSession(request.params.sessionKey)) return reply.code(404).send({ error: "session not found" });
  return { telemetry: store.readContextTelemetry(request.params.sessionKey) };
});

app.get<{ Params: { sessionKey: string } }>("/api/sessions/:sessionKey/context-observer", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const telemetry = store.readContextTelemetry(request.params.sessionKey);
  const records = store.readContextRecords(request.params.sessionKey);
  const preview = telemetry.length === 0 ? prepareSessionContext({
    capabilityIndex: capabilityDigest(session.projectRoot),
    currentCycleKey: "context_preview",
    memoryIndex: store.memoryDigest(session.projectRoot),
    model: session.model,
    projectRoot: session.projectRoot,
    prompt: "",
    providerContextWindowTokens: getContextWindowTokens(),
    records,
    session,
    tokenCalibrationFactor: store.readTokenCalibrationFactor(session.model),
    tools: runtimeToolDefinitions
  }).telemetry : undefined;
  return {
    observer: {
      latest: telemetry.at(-1) ?? preview,
      memoryFactCount: store.readMemoryFacts(session.projectRoot).length,
      recent: telemetry.slice(-20),
      sessionKey: session.sessionKey,
      updates: records.filter((record) => record.kind === "context_update").slice(-50).map((record) => ({
        createdAt: record.createdAt,
        kind: record.metadata?.updateKind ?? "context_update",
        label: record.metadata?.label ?? "Context update",
        loadingReason: record.metadata?.activationReason,
        recordKey: record.recordKey,
        revisionHash: record.metadata?.revisionHash,
        source: record.metadata?.sourceFile,
        survivesCompaction: false,
        trust: record.metadata?.trust
      }))
    }
  };
});

app.get<{ Params: { sessionKey: string } }>("/api/sessions/:sessionKey/memory", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { facts: store.readMemoryFacts(session.projectRoot) };
});

app.post<{
  Body: Partial<MemoryFact> & Pick<MemoryFact, "category" | "confidence" | "provenance" | "statement" | "visibility">;
}>("/api/memory", async (request, reply) => {
  try {
    return { fact: store.upsertMemoryFact(request.body) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid memory fact" });
  }
});

app.delete<{ Params: { memoryId: string } }>("/api/memory/:memoryId", async (request, reply) => {
  return reply.code(store.deleteMemoryFact(request.params.memoryId) ? 200 : 404).send({ ok: true });
});

app.get<{
  Params: { sessionKey: string };
  Querystring: { path?: string };
}>("/api/sessions/:sessionKey/files", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const filePath = request.query.path?.trim();
  if (!filePath) return reply.code(400).send({ error: "path is required" });
  try {
    const absolutePath = ensureInsideRoot(session.projectRoot, filePath);
    const contents = await fs.readFile(absolutePath, "utf8");
    const maxChars = 400_000;
    return {
      content: contents.slice(0, maxChars),
      path: filePath,
      projectRoot: session.projectRoot,
      truncated: contents.length > maxChars
    };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "file not found" });
  }
});

app.get<{ Params: { cycleKey: string } }>("/api/cycles/:cycleKey", { schema: cycleParamsSchema }, async (request, reply) => {
  const cycle = store.getCycle(request.params.cycleKey);
  if (!cycle) return reply.code(404).send({ error: "cycle not found" });
  return { cycle };
});

app.post<{
  Body: { model?: string; permissionProfile?: PermissionProfileKey; projectRoot?: string; prompt?: string; sessionKey?: string };
}>("/api/cycles", { schema: createCycleSchema }, async (request, reply) => {
  const prompt = request.body.prompt?.trim();
  if (!prompt) return reply.code(400).send({ error: "prompt is required" });
  const model = request.body.model ?? defaultModel;
  const sessionKey = request.body.sessionKey ?? `session_${randomUUID()}`;
  let session = store.getSession(sessionKey);
  const projectRoot = session?.projectRoot ?? await resolveInitialProjectRoot({
    explicitRoot: request.body.projectRoot,
    fallbackRoot: workspaceRoot,
    prompt
  });
  if (!session) {
    session = store.registerSession({
      compactThresholdTokens: getCompactThresholdTokens(),
      contextWindowTokens: getContextWindowTokens(),
      model,
      permissionProfile: request.body.permissionProfile ?? "request_approval",
      projectRoot,
      sessionKey,
      title: prompt.slice(0, 42) || "新任务"
    });
  }
  if (request.body.permissionProfile && request.body.permissionProfile !== session.permissionProfile) {
    store.append({
      payload: { permissionProfile: request.body.permissionProfile },
      sessionKey,
      topic: "session.permissionProfile.changed"
    });
    session = store.getSession(sessionKey)!;
  }
  if (session.cycles.some((cycle) => cycle.phase === "active" || cycle.phase === "awaiting_approval" || cycle.phase === "queued")) {
    return reply.code(409).send({ error: "session already has an active work cycle" });
  }

  const cycleKey = `cycle_${randomUUID()}`;
  store.append({
    cycleKey,
    payload: { model, prompt, startedAt: new Date().toISOString() },
    sessionKey,
    topic: "cycle.accepted"
  });
  const controller = registry.startCycle(cycleKey);
  const useMock = model === "mock-agent" || process.env.RUNTIME_MODE === "mock" || !process.env.DEEPSEEK_API_KEY;
  const provider = useMock ? new MockProvider() : new DeepSeekProvider(process.env.DEEPSEEK_API_KEY ?? "");

  void runAgentCycle({
    cycleKey,
    model: useMock ? "mock-agent" : model,
    projectRoot,
    prompt,
    provider,
    registry,
    sessionKey,
    signal: controller.signal,
    store
  })
    .catch((error) => {
      const cycle = store.getCycle(cycleKey);
      if (!cycle || cycle.phase === "succeeded" || cycle.phase === "failed" || cycle.phase === "cancelled") return;
      const cancelled = controller.signal.aborted;
      settleWorkCycle({
        cycleKey,
        failure: cancelled ? "用户取消了运行。" : error instanceof Error ? error.message : String(error),
        failureType: cancelled ? "cancelled" : "runtime_error",
        finalResponse: cancelled ? "运行已取消。" : "本次运行未能完成。",
        phase: cancelled ? "cancelled" : "failed",
        projectRoot,
        sessionKey,
        store
      });
    })
    .finally(() => registry.finishCycle(cycleKey));

  return reply.send({ cycle: store.getCycle(cycleKey), session: store.getSession(sessionKey) });
});

app.get<{
  Params: { sessionKey: string };
  Querystring: { afterOffset?: string };
}>("/api/sessions/:sessionKey/signals", async (request, reply) => {
  if (!store.getSession(request.params.sessionKey)) return reply.code(404).send({ error: "session not found" });
  const afterOffset = Math.max(0, Number(request.query.afterOffset ?? 0));
  return { signals: store.readSignals(request.params.sessionKey, afterOffset) };
});

app.get<{
  Params: { sessionKey: string };
  Querystring: { afterOffset?: string };
}>("/api/sessions/:sessionKey/stream", async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  let lastOffset = Math.max(0, Number(request.query.afterOffset ?? 0));
  reply.raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no"
  });
  const unsubscribe = store.subscribe(request.params.sessionKey, (signals) => {
    const fresh = signals.filter((signal) => signal.offset > lastOffset);
    if (fresh.length === 0) return;
    lastOffset = fresh.at(-1)!.offset;
    writeSSE(reply.raw, { kind: "signals", sessionKey: request.params.sessionKey, signals: fresh });
  });
  const backlog = store.readSignals(request.params.sessionKey, lastOffset);
  if (backlog.length > 0) {
    lastOffset = backlog.at(-1)!.offset;
    writeSSE(reply.raw, { kind: "signals", sessionKey: request.params.sessionKey, signals: backlog });
  }
  const heartbeat = setInterval(() => {
    writeSSE(reply.raw, { kind: "heartbeat", offset: lastOffset, sessionKey: request.params.sessionKey });
  }, 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post<{ Params: { cycleKey: string } }>("/api/cycles/:cycleKey/cancel", async (request, reply) => {
  const cancelled = registry.cancelCycle(request.params.cycleKey);
  return reply.code(cancelled ? 200 : 404).send({ ok: cancelled });
});

app.put<{
  Params: { sessionKey: string };
  Body: { permissionProfile?: PermissionProfileKey };
}>("/api/sessions/:sessionKey/permission-profile", async (request, reply) => {
  const session = store.getSession(request.params.sessionKey);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const permissionProfile = request.body.permissionProfile;
  if (!permissionProfile || !["request_approval", "smart_approval", "full_access"].includes(permissionProfile)) {
    return reply.code(400).send({ error: "invalid permission profile" });
  }
  store.append({
    payload: { permissionProfile },
    sessionKey: session.sessionKey,
    topic: "session.permissionProfile.changed"
  });
  return { session: store.getSession(session.sessionKey) };
});

app.post<{
  Params: { approvalKey: string };
  Body: { decision?: ApprovalDecision };
}>("/api/approvals/:approvalKey/resolve", async (request, reply) => {
  const decision = request.body.decision;
  if (!decision || !["allow_once", "allow_cycle", "allow_session", "deny"].includes(decision)) {
    return reply.code(400).send({ error: "invalid decision" });
  }
  const resolved = registry.resolveApproval({ approvalKey: request.params.approvalKey, decision, store });
  return reply.code(resolved ? 200 : 404).send({ ok: resolved });
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.server.closeAllConnections();
  await app.close().catch(() => undefined);
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

app.listen({ host: "127.0.0.1", port }).then(() => {
  console.log(`DeepSeeker Runtime listening on http://127.0.0.1:${port}`);
});
