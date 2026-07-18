import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { FastifyInstance } from "fastify";
import { ApprovalChoice, AccessMode, EventStream, Session } from "../../shared/contracts/runtime";
import { MemoryFact } from "../../shared/contracts/context";
import { Provider, ToolSpec } from "../../shared/contracts/provider";
import { CapabilitySource } from "../../shared/contracts/capability";
import { RuleSource } from "../../shared/contracts/rules";
import {
  accessInputSchema,
  approvalInputSchema,
  eventQuerySchema,
  runInputSchema,
  runParamsSchema,
  sessionParamsSchema
} from "../../shared/schemas/http";
import { RunInput } from "../app/runner";
import { finishRun } from "../app/runLifecycle";
import { ContextConfig, getCompactThresholdTokens, getContextWindowTokens, getEffectiveInputBudgetTokens, getRequestedMaxOutputTokens, prepareSessionContext } from "../app/contextBuilder";
import { RunRegistry } from "../app/runRegistry";
import { RuntimeStore } from "../infra/runtimeStore";

export type HttpConfig = {
  dataDirectory: string;
  context: ContextConfig;
  defaultModel: string;
  frontendUrl: string;
  hasApiKey: boolean;
  workspaceRoot: string;
};

export type HttpDeps = {
  capabilities: CapabilitySource;
  config: HttpConfig;
  providerFor: (model: string) => { model: string; provider: Provider };
  registry: RunRegistry;
  resolveProjectRoot: (input: { explicitRoot?: string; fallbackRoot: string; prompt: string }) => Promise<string>;
  rules: RuleSource;
  run: (input: Omit<RunInput, "tools">) => Promise<void>;
  store: RuntimeStore;
  tools: ToolSpec[];
};

export function createHttp(deps: HttpDeps): FastifyInstance {
  const { capabilities, config, providerFor, registry, resolveProjectRoot, rules, run, store, tools } = deps;
  const { context, dataDirectory, defaultModel, frontendUrl, hasApiKey, workspaceRoot } = config;
  const app = Fastify({ logger: false });

function createContextPreview(): ReturnType<typeof prepareSessionContext>["telemetry"] {
  const now = new Date().toISOString();
  const session: Session = {
    compactThresholdTokens: getCompactThresholdTokens(context.windowTokens, context.maxOutputTokens, context),
    contextTokens: 0,
    contextWindowTokens: getContextWindowTokens(context),
    createdAt: now,
    runIds: [],
    runs: [],
    lastOffset: 0,
    model: defaultModel,
    grants: [],
    accessMode: "request_approval",
    projectRoot: workspaceRoot,
    sessionId: "context_preview",
    title: "Context preview",
    updatedAt: now
  };
  return prepareSessionContext({
    capabilityIndex: capabilities.digest(workspaceRoot),
    context,
    runId: "context_preview",
    memoryIndex: store.memoryDigest(workspaceRoot),
    model: defaultModel,
    projectRoot: workspaceRoot,
    prompt: "",
    records: [],
    rules,
    session,
    tokenCalibrationFactor: store.readCalibration(defaultModel),
    tools
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

function writeSSE(raw: NodeJS.WritableStream, message: EventStream): void {
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
  compactThresholdTokens: getCompactThresholdTokens(context.windowTokens, context.maxOutputTokens, context),
  contextWindowTokens: getContextWindowTokens(context),
  effectiveInputBudgetTokens: getEffectiveInputBudgetTokens(context.windowTokens, context.maxOutputTokens, context),
  requestedMaxOutputTokens: getRequestedMaxOutputTokens(context),
  contextPreview: createContextPreview(),
  defaultModel,
  hasApiKey,
  eventContract: "deepseeker.events/v2"
}));

app.get<{ Querystring: { query?: string } }>("/api/sessions", async (request) => ({
  sessions: store.listSessions(request.query.query ?? "")
}));

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { session };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/context-telemetry", { schema: sessionParamsSchema }, async (request, reply) => {
  if (!store.getSession(request.params.sessionId)) return reply.code(404).send({ error: "session not found" });
  return { telemetry: store.readMetrics(request.params.sessionId) };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/context-observer", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const telemetry = store.readMetrics(request.params.sessionId);
  const records = store.readContextEntries(request.params.sessionId);
  const preview = telemetry.length === 0 ? prepareSessionContext({
    capabilityIndex: capabilities.digest(session.projectRoot),
    context,
    runId: "context_preview",
    memoryIndex: store.memoryDigest(session.projectRoot),
    model: session.model,
    projectRoot: session.projectRoot,
    prompt: "",
    providerContextWindowTokens: getContextWindowTokens(context),
    records,
    rules,
    session,
    tokenCalibrationFactor: store.readCalibration(session.model),
    tools
  }).telemetry : undefined;
  return {
    observer: {
      latest: telemetry.at(-1) ?? preview,
      memoryFactCount: store.readMemories(session.projectRoot).length,
      recent: telemetry.slice(-20),
      sessionId: session.sessionId,
      updates: records.filter((record) => record.kind === "context_update").slice(-50).map((record) => ({
        createdAt: record.createdAt,
        kind: record.metadata?.updateKind ?? "context_update",
        label: record.metadata?.label ?? "Context update",
        loadingReason: record.metadata?.activationReason,
        recordId: record.recordId,
        revisionHash: record.metadata?.revisionHash,
        source: record.metadata?.sourceFile,
        survivesCompaction: false,
        trust: record.metadata?.trust
      }))
    }
  };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/memory", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { facts: store.readMemories(session.projectRoot) };
});

app.post<{
  Body: Partial<MemoryFact> & Pick<MemoryFact, "category" | "confidence" | "provenance" | "statement" | "visibility">;
}>("/api/memory", async (request, reply) => {
  try {
    return { fact: store.saveMemory(request.body) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid memory fact" });
  }
});

app.delete<{ Params: { memoryId: string } }>("/api/memory/:memoryId", async (request, reply) => {
  return reply.code(store.deleteMemory(request.params.memoryId) ? 200 : 404).send({ ok: true });
});

app.get<{
  Params: { sessionId: string };
  Querystring: { path?: string };
}>("/api/sessions/:sessionId/files", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
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

app.get<{ Params: { runId: string } }>("/api/runs/:runId", { schema: runParamsSchema }, async (request, reply) => {
  const run = store.getRun(request.params.runId);
  if (!run) return reply.code(404).send({ error: "run not found" });
  return { run };
});

app.post<{
  Params: { sessionId: string };
  Body: { model?: string; accessMode?: AccessMode; projectRoot?: string; prompt?: string; sessionId?: string };
}>("/api/sessions/:sessionId/runs", { schema: runInputSchema }, async (request, reply) => {
  const prompt = request.body.prompt?.trim();
  if (!prompt) return reply.code(400).send({ error: "prompt is required" });
  const model = request.body.model ?? defaultModel;
  const sessionId = request.params.sessionId;
  let session = store.getSession(sessionId);
  const projectRoot = session?.projectRoot ?? await resolveProjectRoot({
    explicitRoot: request.body.projectRoot,
    fallbackRoot: workspaceRoot,
    prompt
  });
  if (!session) {
    session = store.createSession({
      compactThresholdTokens: getCompactThresholdTokens(context.windowTokens, context.maxOutputTokens, context),
      contextWindowTokens: getContextWindowTokens(context),
      model,
      accessMode: request.body.accessMode ?? "request_approval",
      projectRoot,
      sessionId,
      title: prompt.slice(0, 42) || "新任务"
    });
  }
  if (request.body.accessMode && request.body.accessMode !== session.accessMode) {
    store.append({
      data: { accessMode: request.body.accessMode },
      sessionId,
      type: "session.updated"
    });
    session = store.getSession(sessionId)!;
  }
  if (session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued")) {
    return reply.code(409).send({ error: "session already has an active run" });
  }

  const runId = `run_${randomUUID()}`;
  store.append({
    runId,
    data: { model, prompt, startedAt: new Date().toISOString() },
    sessionId,
    type: "run.started"
  });
  const controller = registry.startRun(runId);
  const selected = providerFor(model);

  void run({
    runId,
    model: selected.model,
    projectRoot,
    prompt,
    provider: selected.provider,
    registry,
    sessionId,
    signal: controller.signal,
    store
  })
    .catch((error) => {
      const run = store.getRun(runId);
      if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
      const cancelled = controller.signal.aborted;
      finishRun({
        runId,
        error: cancelled ? "用户取消了运行。" : error instanceof Error ? error.message : String(error),
        failureType: cancelled ? "cancelled" : "runtime_error",
        answer: cancelled ? "运行已取消。" : "本次运行未能完成。",
        status: cancelled ? "cancelled" : "failed",
        projectRoot,
        sessionId,
        store
      });
    })
    .finally(() => registry.finishRun(runId));

  return reply.send({ run: store.getRun(runId), session: store.getSession(sessionId) });
});

app.get<{
  Params: { sessionId: string };
  Querystring: { afterOffset?: string };
}>("/api/sessions/:sessionId/events", { schema: eventQuerySchema }, async (request, reply) => {
  if (!store.getSession(request.params.sessionId)) return reply.code(404).send({ error: "session not found" });
  const afterOffset = Math.max(0, Number(request.query.afterOffset ?? 0));
  return { events: store.readEvents(request.params.sessionId, afterOffset) };
});

app.get<{
  Params: { sessionId: string };
  Querystring: { afterOffset?: string };
}>("/api/sessions/:sessionId/stream", async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  let lastOffset = Math.max(0, Number(request.query.afterOffset ?? 0));
  reply.raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no"
  });
  const unsubscribe = store.subscribe(request.params.sessionId, (events) => {
    const fresh = events.filter((event) => event.offset > lastOffset);
    if (fresh.length === 0) return;
    lastOffset = fresh.at(-1)!.offset;
    writeSSE(reply.raw, { events: fresh, kind: "events", sessionId: request.params.sessionId });
  });
  const backlog = store.readEvents(request.params.sessionId, lastOffset);
  if (backlog.length > 0) {
    lastOffset = backlog.at(-1)!.offset;
    writeSSE(reply.raw, { events: backlog, kind: "events", sessionId: request.params.sessionId });
  }
  const heartbeat = setInterval(() => {
    writeSSE(reply.raw, { kind: "heartbeat", offset: lastOffset, sessionId: request.params.sessionId });
  }, 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", { schema: runParamsSchema }, async (request, reply) => {
  const cancelled = registry.cancelRun(request.params.runId);
  return reply.code(cancelled ? 200 : 404).send({ ok: cancelled });
});

app.put<{
  Params: { sessionId: string };
  Body: { accessMode?: AccessMode };
}>("/api/sessions/:sessionId/access-mode", { schema: accessInputSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const accessMode = request.body.accessMode;
  if (!accessMode || !["request_approval", "smart_approval", "full_access"].includes(accessMode)) {
    return reply.code(400).send({ error: "invalid permission profile" });
  }
  store.append({
    data: { accessMode },
    sessionId: session.sessionId,
    type: "session.updated"
  });
  return { session: store.getSession(session.sessionId) };
});

app.post<{
  Params: { approvalId: string };
  Body: { decision?: ApprovalChoice };
}>("/api/approvals/:approvalId/resolve", { schema: approvalInputSchema }, async (request, reply) => {
  const decision = request.body.decision;
  if (!decision || !["allow_once", "allow_run", "allow_session", "deny"].includes(decision)) {
    return reply.code(400).send({ error: "invalid decision" });
  }
  const resolved = registry.resolveApproval({ approvalId: request.params.approvalId, decision, store });
  return reply.code(resolved ? 200 : 404).send({ ok: resolved });
});

  return app;
}
