import Fastify, { FastifyInstance } from "fastify";
import { ApprovalChoice, AccessMode, EventStream, Mode, PlanDecision, PlanEntry, Session, WorkspaceKind } from "../../shared/contracts/runtime";
import { MemoryFact } from "../../shared/contracts/context";
import { Provider, ModelOption, ModelProtocol } from "../../shared/contracts/provider";
import {
  accessInputSchema,
  approvalInputSchema,
  commandParamsSchema,
  eventQuerySchema,
  fileQuerySchema,
  followUpInputSchema,
  followUpParamsSchema,
  memoryInputSchema,
  memoryParamsSchema,
  modeInputSchema,
  planResolveInputSchema,
  planRevisionInputSchema,
  projectArchiveInputSchema,
  questionAnswerInputSchema,
  runInputSchema,
  runParamsSchema,
  sessionListQuerySchema,
  sessionParamsSchema,
  sidebarInputSchema
} from "../../shared/schemas/http";
import { ContextConfig, getCompactThresholdTokens, getContextWindowTokens, getEffectiveInputBudgetTokens, getRequestedMaxOutputTokens } from "../app/contextBuilder";
import { AppError, AppErrorCode } from "../app/appError";
import { CancelRun } from "../app/cancelRun";
import { ContextQueries } from "../app/contextQueries";
import { FollowUpService } from "../app/followUps";
import { RunRegistry } from "../app/runRegistry";
import { answerQuestion, resolvePlan, ResumeRun, revisePlan } from "../app/planReview";
import { RunLaunchPort } from "../app/runLauncher";
import { ContextPort, EventPort, MemoryPort, SessionPort } from "../app/runtimeRepo";
import { SessionService } from "../app/sessionService";
import { StartRun } from "../app/startRun";
import { WorkspaceQueries } from "../app/workspaceQueries";
import {
  EvalBatchRunRecord,
  EvalCaseSummary,
  EvalRunRecord,
  StartEvalBatchInput,
  StartEvalRunInput
} from "../../shared/contracts/evals";

export type HttpConfig = {
  authToken?: string;
  dataDirectory: string;
  context: ContextConfig;
  defaultModel: string;
  evalsEnabled?: boolean;
  frontendUrl: string;
  hasApiKey: boolean;
  models: ModelOption[];
  workspaceRoot: string;
};

export type HttpDeps = {
  cancelRun: CancelRun;
  config: HttpConfig;
  contextQueries: ContextQueries;
  evals?: DeveloperEvalService;
  followUps: FollowUpService;
  launcher: RunLaunchPort;
  providerFor: (model: string, protocol?: ModelProtocol) => { model: string; provider: Provider };
  registry: RunRegistry;
  sessions: SessionService;
  startRun: StartRun;
  store: ContextPort & EventPort & MemoryPort & SessionPort;
  workspace: WorkspaceQueries;
};

export type DeveloperEvalService = {
  batches: () => EvalBatchRunRecord[];
  cases: () => EvalCaseSummary[];
  close: () => Promise<void>;
  get: (evalRunId: string) => EvalRunRecord | undefined;
  pauseBatch: (batchId: string) => EvalBatchRunRecord | undefined;
  resumeBatch: (batchId: string) => EvalBatchRunRecord | undefined;
  runs: () => EvalRunRecord[];
  session: (evalRunId: string) => Session | undefined;
  shutdown: () => Promise<void>;
  start: (input: StartEvalRunInput) => Promise<EvalRunRecord>;
  startBatch: (input: StartEvalBatchInput) => Promise<EvalBatchRunRecord>;
};

function statusFor(code: AppErrorCode): 400 | 404 | 409 {
  if (code === "not_found") return 404;
  if (code === "conflict" || code === "not_waiting" || code === "stale_revision") return 409;
  return 400;
}

export function createHttp(deps: HttpDeps): FastifyInstance {
  const { cancelRun, config, contextQueries, evals, followUps, launcher, providerFor, registry, sessions, startRun, store, workspace } = deps;
  const { authToken, context, dataDirectory, defaultModel, evalsEnabled = false, frontendUrl, hasApiKey, models, workspaceRoot } = config;
  const app = Fastify({ logger: false });
  const frontendOrigin = new URL(frontendUrl).origin;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(statusFor(error.code)).send({ code: error.code, error: error.message });
    }
    return reply.send(error);
  });

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

function resumeRun(resume: ResumeRun): void {
  launcher.launch({
    continuation: true,
    model: resume.model,
    protocol: resume.protocol,
    projectRoot: resume.projectRoot,
    prompt: resume.prompt,
    runId: resume.runId,
    sessionId: resume.sessionId
  });
}

function createContextPreview() {
  return contextQueries.preview();
}

function writeSSE(raw: NodeJS.WritableStream, message: EventStream): void {
  raw.write(`data: ${JSON.stringify(message)}\n\n`);
}

app.get("/api/health", async () => ({ ok: true, service: "deepcreator-runtime", storage: dataDirectory }));

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${frontendUrl}" />
    <title>DeepCreator Runtime</title>
  </head>
  <body>
    <p>DeepCreator Runtime 正在运行。正在打开前端：<a href="${frontendUrl}">${frontendUrl}</a></p>
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
  eventContract: "deepcreator.events/v2",
  evalsEnabled,
  models,
  planEntry: "suggest",
  workspaceRoot
}));

if (evals) {
  app.get("/api/evals/batches", async () => ({ batches: evals.batches() }));
  app.get("/api/evals/cases", async () => ({ cases: evals.cases() }));
  app.get("/api/evals/runs", async () => ({ runs: evals.runs() }));
  app.get<{ Params: { evalRunId: string } }>("/api/evals/runs/:evalRunId", async (request, reply) => {
    const run = evals.get(request.params.evalRunId);
    return run ? { run } : reply.code(404).send({ error: "eval run not found" });
  });
  app.get<{ Params: { evalRunId: string } }>("/api/evals/runs/:evalRunId/session", async (request, reply) => {
    const session = evals.session(request.params.evalRunId);
    return session ? { session } : reply.code(404).send({ error: "eval session not found" });
  });
  app.post<{ Body: StartEvalRunInput }>("/api/evals/runs", async (request, reply) => {
    const { caseId, judge, judgeModel, model, promptVersion } = request.body ?? {} as StartEvalRunInput;
    if (!caseId || !model) return reply.code(400).send({ error: "caseId and model are required" });
    if (judge && judge !== "heuristic" && judge !== "provider") return reply.code(400).send({ error: "invalid judge" });
    const run = await evals.start({ caseId, judge, judgeModel, model, promptVersion });
    return reply.code(run.stage === "failed" ? 500 : 202).send({ run });
  });
  app.post<{ Body: StartEvalBatchInput }>("/api/evals/batches", async (request, reply) => {
    const { judge, judgeModel, model, promptVersion } = request.body ?? {} as StartEvalBatchInput;
    if (!model) return reply.code(400).send({ error: "model is required" });
    if (judge && judge !== "heuristic" && judge !== "provider") return reply.code(400).send({ error: "invalid judge" });
    const batch = await evals.startBatch({ judge, judgeModel, model, promptVersion });
    return reply.code(202).send({ batch });
  });
  app.post<{ Params: { batchId: string } }>("/api/evals/batches/:batchId/pause", async (request, reply) => {
    const batch = evals.pauseBatch(request.params.batchId);
    return batch ? { batch } : reply.code(404).send({ error: "eval batch not found" });
  });
  app.post<{ Params: { batchId: string } }>("/api/evals/batches/:batchId/resume", async (request, reply) => {
    const batch = evals.resumeBatch(request.params.batchId);
    return batch ? { batch } : reply.code(404).send({ error: "eval batch not found" });
  });
}

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

app.get<{ Querystring: { query?: string } }>("/api/sessions", { schema: sessionListQuerySchema }, async (request) => ({
  sessions: sessions.list(request.query.query ?? "")
}));

app.put<{
  Params: { sessionId: string };
  Body: { archived?: boolean; pinned?: boolean };
}>("/api/sessions/:sessionId/sidebar", { schema: sidebarInputSchema }, async (request) => {
  sessions.updateSidebar(request.params.sessionId, request.body);
  return { ok: true };
});

app.post<{
  Body: { projectRoot?: string };
}>("/api/projects/archive-sessions", { schema: projectArchiveInputSchema }, async (request) => {
  return { archived: sessions.archiveProject(request.body.projectRoot ?? "") };
});

app.post<{
  Params: { sessionId: string };
  Body: { model: string; accessMode: AccessMode; mode: Mode; planEntry: PlanEntry; prompt: string };
}>("/api/sessions/:sessionId/follow-ups", { schema: followUpInputSchema }, async (request) => {
  return followUps.queue({ ...request.body, sessionId: request.params.sessionId });
});

app.delete<{ Params: { sessionId: string; followUpId: string } }>(
  "/api/sessions/:sessionId/follow-ups/:followUpId",
  { schema: followUpParamsSchema },
  async (request) => followUps.remove(request.params.sessionId, request.params.followUpId)
);

app.post<{ Params: { sessionId: string; followUpId: string } }>(
  "/api/sessions/:sessionId/follow-ups/:followUpId/steer",
  { schema: followUpParamsSchema },
  async (request) => followUps.steer(request.params.sessionId, request.params.followUpId)
);

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { session };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/workspace", { schema: sessionParamsSchema }, async (request) => {
  return { workspace: await workspace.describe(request.params.sessionId) };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/changes", { schema: sessionParamsSchema }, async (request) => {
  return workspace.changes(request.params.sessionId);
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/context-telemetry", { schema: sessionParamsSchema }, async (request) => {
  return { telemetry: contextQueries.telemetry(request.params.sessionId) };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/context-observer", { schema: sessionParamsSchema }, async (request) => {
  return { observer: contextQueries.observer(request.params.sessionId) };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/memory", { schema: sessionParamsSchema }, async (request, reply) => {
  const session = store.getSession(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: "session not found" });
  return { facts: store.readMemories(session.projectRoot) };
});

app.post<{
  Body: Partial<MemoryFact> & Pick<MemoryFact, "category" | "confidence" | "provenance" | "statement" | "visibility">;
}>("/api/memory", { schema: memoryInputSchema }, async (request, reply) => {
  try {
    return { fact: store.saveMemory(request.body) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid memory fact" });
  }
});

app.put<{
  Params: { sessionId: string; planId: string; revision: string };
  Body: { markdown?: string; title?: string };
}>("/api/sessions/:sessionId/plans/:planId/revisions/:revision", { schema: planRevisionInputSchema }, async (request) => {
  const session = revisePlan({
    markdown: request.body.markdown ?? "",
    planId: request.params.planId,
    revision: Number(request.params.revision),
    sessionId: request.params.sessionId,
    store,
    system: registry.system,
    title: request.body.title ?? ""
  });
  return { session };
});

app.delete<{ Params: { memoryId: string } }>("/api/memory/:memoryId", { schema: memoryParamsSchema }, async (request, reply) => {
  return reply.code(store.deleteMemory(request.params.memoryId) ? 200 : 404).send({ ok: true });
});

app.get<{
  Params: { sessionId: string };
  Querystring: { path?: string };
}>("/api/sessions/:sessionId/files", { schema: fileQuerySchema }, async (request) => {
  return workspace.readFile(request.params.sessionId, request.query.path);
});

app.get<{ Params: { runId: string } }>("/api/runs/:runId", { schema: runParamsSchema }, async (request, reply) => {
  const run = store.getRun(request.params.runId);
  if (!run) return reply.code(404).send({ error: "run not found" });
  return { run };
});

app.post<{
  Params: { sessionId: string };
  Body: { model?: string; accessMode?: AccessMode; mode?: Mode; planEntry?: PlanEntry; projectRoot?: string; prompt?: string; sessionId?: string; workspaceKind?: WorkspaceKind };
}>("/api/sessions/:sessionId/runs", { schema: runInputSchema }, async (request) => {
  return startRun.execute({
    accessMode: request.body.accessMode,
    mode: request.body.mode,
    model: request.body.model,
    planEntry: request.body.planEntry,
    projectRoot: request.body.projectRoot,
    prompt: request.body.prompt ?? "",
    sessionId: request.params.sessionId,
    workspaceKind: request.body.workspaceKind
  });
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
}>("/api/sessions/:sessionId/stream", { schema: eventQuerySchema }, async (request, reply) => {
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
  const result = await cancelRun.execute(request.params.runId);
  if (!result.cancelled) return reply.code(404).send({ ok: false });
  return reply.send({ ok: true, settled: result.settled });
});

app.post<{ Params: { commandId: string } }>("/api/commands/:commandId/stop", { schema: commandParamsSchema }, async (request, reply) => {
  const stopped = await cancelRun.stopCommand(request.params.commandId);
  return reply.code(stopped ? 200 : 404).send({ command: stopped, ok: Boolean(stopped) });
});

app.put<{
  Params: { sessionId: string };
  Body: { accessMode?: AccessMode };
}>("/api/sessions/:sessionId/access-mode", { schema: accessInputSchema }, async (request) => {
  return { session: sessions.changeAccessMode(request.params.sessionId, request.body.accessMode) };
});

app.put<{
  Params: { sessionId: string };
  Body: { mode?: Mode; planEntry?: PlanEntry };
}>("/api/sessions/:sessionId/mode", { schema: modeInputSchema }, async (request) => {
  return { session: sessions.changeMode(request.params.sessionId, request.body) };
});

app.post<{
  Params: { sessionId: string; planId: string; revision: string };
  Body: { accessMode?: AccessMode; comments?: string; decision?: PlanDecision };
}>("/api/sessions/:sessionId/plans/:planId/revisions/:revision/resolve", { schema: planResolveInputSchema }, async (request, reply) => {
  const decision = request.body.decision;
  if (!decision || !["continue_planning", "start_work", "cancel"].includes(decision)) {
    return reply.code(400).send({ error: "invalid plan decision" });
  }
  const result = resolvePlan({
    accessMode: request.body.accessMode,
    comments: request.body.comments,
    decision,
    planId: request.params.planId,
    revision: Number(request.params.revision),
    sessionId: request.params.sessionId,
    store,
    system: registry.system
  });
  if (result.resume) resumeRun(result.resume);
  return { idempotent: result.idempotent, session: result.session };
});

app.post<{
  Params: { sessionId: string; interactionId: string };
  Body: { answers?: Record<string, string> };
}>("/api/sessions/:sessionId/questions/:interactionId/answer", { schema: questionAnswerInputSchema }, async (request) => {
  const result = answerQuestion({
    answers: request.body.answers ?? {},
    interactionId: request.params.interactionId,
    sessionId: request.params.sessionId,
    store,
    system: registry.system
  });
  if (result.resume) resumeRun(result.resume);
  return { idempotent: result.idempotent, session: result.session };
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
