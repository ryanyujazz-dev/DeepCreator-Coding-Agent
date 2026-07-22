import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { FastifyInstance } from "fastify";
import { ApprovalChoice, AccessMode, EventStream, Mode, PlanDecision, PlanEntry, Session } from "../../shared/contracts/runtime";
import { MemoryFact } from "../../shared/contracts/context";
import { Provider, ToolSpec } from "../../shared/contracts/provider";
import { CapabilitySource } from "../../shared/contracts/capability";
import { RuleSource } from "../../shared/contracts/rules";
import {
  accessInputSchema,
  approvalInputSchema,
  commandParamsSchema,
  eventQuerySchema,
  modeInputSchema,
  runInputSchema,
  runParamsSchema,
  sessionParamsSchema
} from "../../shared/schemas/http";
import { RunInput } from "../app/runner";
import { finishRun } from "../app/runLifecycle";
import { ContextConfig, getCompactThresholdTokens, getContextWindowTokens, getEffectiveInputBudgetTokens, getRequestedMaxOutputTokens, prepareSessionContext } from "../app/contextBuilder";
import { RunRegistry } from "../app/runRegistry";
import { answerQuestion, resolvePlan, ResumeRun, revisePlan } from "../app/planReview";
import { RuntimeStore } from "../infra/runtimeStore";
import { WorkspaceInfo } from "../infra/workspace";
import { CommandManager } from "../infra/commandManager";

export type HttpConfig = {
  authToken?: string;
  dataDirectory: string;
  context: ContextConfig;
  defaultModel: string;
  frontendUrl: string;
  hasApiKey: boolean;
  workspaceRoot: string;
};

export type HttpDeps = {
  capabilities: CapabilitySource;
  commands: CommandManager;
  config: HttpConfig;
  providerFor: (model: string) => { model: string; provider: Provider };
  registry: RunRegistry;
  resolveProjectRoot: (input: { explicitRoot?: string; fallbackRoot: string; prompt: string }) => Promise<string>;
  rules: RuleSource;
  run: (input: Omit<RunInput, "tools">) => Promise<void>;
  store: RuntimeStore;
  tools: ToolSpec[];
  workspaceInfo: (projectRoot: string) => Promise<WorkspaceInfo>;
};

export function createHttp(deps: HttpDeps): FastifyInstance {
  const { capabilities, commands, config, providerFor, registry, resolveProjectRoot, rules, run, store, tools, workspaceInfo } = deps;
  const { authToken, context, dataDirectory, defaultModel, frontendUrl, hasApiKey, workspaceRoot } = config;
  const app = Fastify({ logger: false });
  const frontendOrigin = new URL(frontendUrl).origin;

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigin = origin === "null" || origin === frontendOrigin;
    if (origin && allowedOrigin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "DELETE, GET, OPTIONS, POST, PUT");
      reply.header("Vary", "Origin");
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.raw.setHeader("Access-Control-Allow-Methods", "DELETE, GET, OPTIONS, POST, PUT");
      reply.raw.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS" && request.url.startsWith("/api/")) {
      if (origin && !allowedOrigin) return reply.code(403).send({ error: "origin not allowed" });
      return reply.code(204).send();
    }
    if (!authToken || !request.url.startsWith("/api/")) return;
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      return reply.code(401).send({ error: "runtime authorization required" });
    }
  });

function explicitPlanMode(prompt: string): boolean {
  return /(?:先|只|请).{0,12}(?:规划|计划|设计方案|分析方案)|(?:不要|先别|暂不).{0,8}(?:修改|改代码|执行|实现)|plan\s+mode/i.test(prompt);
}

function resumeRun(resume: ResumeRun): void {
  if (registry.hasRun(resume.runId)) {
    registry.afterRun(resume.runId, () => resumeRun(resume));
    return;
  }
  const controller = registry.startRun(resume.runId);
  const selected = providerFor(resume.model);
  void run({
    continuation: true,
    model: selected.model,
    projectRoot: resume.projectRoot,
    prompt: resume.prompt,
    provider: selected.provider,
    registry,
    runId: resume.runId,
    sessionId: resume.sessionId,
    signal: controller.signal,
    store
  }).finally(() => registry.finishRun(resume.runId));
}

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
    mode: "work",
    planEntry: "suggest",
    plans: [],
    questions: [],
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
  eventContract: "deepseeker.events/v2",
  planEntry: "suggest",
  workspaceRoot
}));

// 查询账户余额。前端 60s 轮询一次,用于在 context-meter popover 显示剩余额度。
// 复用 providerFor 闭包拿到 provider(已持有解密后的 apiKey)。
// 失败静默:前端 catch 后显示"尚无数据",不打扰用户。
app.get("/api/balance", async (_request, reply) => {
  try {
    if (!hasApiKey) return reply.code(400).send({ error: "未配置 API Key。" });
    const { provider } = providerFor(defaultModel);
    if (!provider.getBalance) return reply.code(501).send({ error: "当前 provider 不支持余额查询。" });
    return await provider.getBalance();
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Querystring: { query?: string } }>("/api/sessions", async (request) => ({
  sessions: store.listSessions(request.query.query ?? "")
}));

app.put<{
  Params: { sessionId: string };
  Body: { archived?: boolean; pinned?: boolean };
}>("/api/sessions/:sessionId/sidebar", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (request.body.archived && session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued")) {
    return reply.code(409).send({ error: "正在执行的任务不能归档" });
  }
  store.updateSessionSidebar(request.params.sessionId, request.body);
  return { ok: true };
});

app.post<{
  Body: { projectRoot?: string };
}>("/api/projects/archive-sessions", async (request, reply) => {
  const projectRoot = request.body.projectRoot?.trim();
  if (!projectRoot) return reply.code(400).send({ error: "projectRoot is required" });
  if (store.listSessions().some((session) => session.projectRoot === projectRoot && session.active)) {
    return reply.code(409).send({ error: "项目中仍有正在执行的任务" });
  }
  return { archived: store.archiveProjectSessions(projectRoot) };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { session };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/workspace", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { workspace: await workspaceInfo(session.projectRoot) };
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

app.put<{
  Params: { sessionId: string; planId: string; revision: string };
  Body: { markdown?: string; title?: string };
}>("/api/sessions/:sessionId/plans/:planId/revisions/:revision", async (request, reply) => {
  try {
    const session = revisePlan({
      markdown: request.body.markdown ?? "",
      planId: request.params.planId,
      revision: Number(request.params.revision),
      sessionId: request.params.sessionId,
      store,
      title: request.body.title ?? ""
    });
    return { session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(/not found/i.test(message) ? 404 : /stale/i.test(message) ? 409 : 400).send({ error: message });
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
  Body: { model?: string; accessMode?: AccessMode; mode?: Mode; planEntry?: PlanEntry; projectRoot?: string; prompt?: string; sessionId?: string };
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
    const mode = request.body.mode ?? (explicitPlanMode(prompt) ? "plan" : "work");
    session = store.createSession({
      compactThresholdTokens: getCompactThresholdTokens(context.windowTokens, context.maxOutputTokens, context),
      contextWindowTokens: getContextWindowTokens(context),
      model,
      mode,
      planEntry: request.body.planEntry ?? "suggest",
      accessMode: request.body.accessMode ?? "request_approval",
      projectRoot,
      sessionId,
      title: prompt.slice(0, 42) || "新任务"
    });
  }
  if (request.body.planEntry && request.body.planEntry !== session.planEntry) {
    store.append({ data: { planEntry: request.body.planEntry }, sessionId, type: "session.updated" });
    session = store.getSession(sessionId)!;
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
  const requestedMode = request.body.mode ?? (explicitPlanMode(prompt) ? "plan" : session.mode);
  if (requestedMode !== session.mode) {
    store.append({
      data: { mode: requestedMode, previousMode: session.mode, reason: "用户在发送请求时选择了工作模式。", source: "user" },
      sessionId,
      type: "mode.changed"
    });
    session = store.getSession(sessionId)!;
  }

  const runId = `run_${randomUUID()}`;
  store.append({
    runId,
    data: { mode: session.mode, model, prompt, startedAt: new Date().toISOString() },
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
  const drained = registry.waitForRun(request.params.runId);
  const cancelled = registry.cancelRun(request.params.runId);
  if (!cancelled) return reply.code(404).send({ ok: false });
  const [settled] = await Promise.all([
    drained,
    commands.stopRun(request.params.runId).then(() => true)
  ]);
  return reply.send({ ok: true, settled });
});

app.post<{ Params: { commandId: string } }>("/api/commands/:commandId/stop", { schema: commandParamsSchema }, async (request, reply) => {
  const stopped = await commands.stop(request.params.commandId);
  return reply.code(stopped ? 200 : 404).send({ command: stopped, ok: Boolean(stopped) });
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

app.put<{
  Params: { sessionId: string };
  Body: { mode?: Mode; planEntry?: PlanEntry };
}>("/api/sessions/:sessionId/mode", { schema: modeInputSchema }, async (request, reply) => {
  let session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued")) {
    return reply.code(409).send({ error: "active run controls the current mode" });
  }
  if (request.body.planEntry && request.body.planEntry !== session.planEntry) {
    store.append({ data: { planEntry: request.body.planEntry }, sessionId: session.sessionId, type: "session.updated" });
    session = store.getSession(session.sessionId)!;
  }
  if (request.body.mode && request.body.mode !== session.mode) {
    store.append({
      data: { mode: request.body.mode, previousMode: session.mode, reason: "用户切换了工作模式。", source: "user" },
      sessionId: session.sessionId,
      type: "mode.changed"
    });
  }
  return { session: store.getSession(session.sessionId) };
});

app.post<{
  Params: { sessionId: string; planId: string; revision: string };
  Body: { accessMode?: AccessMode; comments?: string; decision?: PlanDecision };
}>("/api/sessions/:sessionId/plans/:planId/revisions/:revision/resolve", async (request, reply) => {
  const decision = request.body.decision;
  if (!decision || !["continue_planning", "start_work", "cancel"].includes(decision)) {
    return reply.code(400).send({ error: "invalid plan decision" });
  }
  try {
    const result = resolvePlan({
      accessMode: request.body.accessMode,
      comments: request.body.comments,
      decision,
      planId: request.params.planId,
      revision: Number(request.params.revision),
      sessionId: request.params.sessionId,
      store
    });
    if (result.resume) resumeRun(result.resume);
    return { idempotent: result.idempotent, session: result.session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(/not found/i.test(message) ? 404 : /stale|not waiting/i.test(message) ? 409 : 400).send({ error: message });
  }
});

app.post<{
  Params: { sessionId: string; interactionId: string };
  Body: { answers?: Record<string, string> };
}>("/api/sessions/:sessionId/questions/:interactionId/answer", async (request, reply) => {
  try {
    const result = answerQuestion({
      answers: request.body.answers ?? {},
      interactionId: request.params.interactionId,
      sessionId: request.params.sessionId,
      store
    });
    if (result.resume) resumeRun(result.resume);
    return { idempotent: result.idempotent, session: result.session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(/not found/i.test(message) ? 404 : /stale/i.test(message) ? 409 : 400).send({ error: message });
  }
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
