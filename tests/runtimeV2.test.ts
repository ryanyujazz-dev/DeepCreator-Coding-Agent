import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testSystem, TestRunRegistry as RunRegistry } from "./support/system";
import { RunLauncher } from "../server/app/runLauncher";
import { CancelRun } from "../server/app/cancelRun";
import { ContextQueries } from "../server/app/contextQueries";
import { FollowUpService } from "../server/app/followUps";
import { runAgent } from "../server/app/runner";
import { SessionService } from "../server/app/sessionService";
import { StartRun } from "../server/app/startRun";
import { WorkspaceQueries } from "../server/app/workspaceQueries";
import { finishRun } from "../server/app/runLifecycle";
import { defaultContextConfig } from "../server/app/contextBuilder";
import { Database } from "../server/infra/database";
import { ContextStore } from "../server/infra/contextStore";
import { EventStore } from "../server/infra/eventStore";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { SessionStore } from "../server/infra/sessionStore";
import { ensureScratchWorkspace } from "../server/infra/sessionWorkspace";
import { toolHost } from "../server/infra/tools";
import { commandManager } from "../server/infra/commandManager";
import { createHttp } from "../server/transport/http";
import { SUMMARY_MODEL_BY_PROVIDER } from "../server/bootstrap/runtime";
import { emptyCapabilitySource } from "../shared/contracts/capability";
import { emptyRuleSource } from "../shared/contracts/rules";
import { Provider } from "../shared/contracts/provider";
import { EVENT_VERSION, Event, EventPayloadMap, EventType, SessionInput } from "../shared/contracts/runtime";
import { createSession, reduceEvent } from "../shared/domain/reducer";
import { decodeLegacyEvent } from "../shared/legacy/decoder";
import { decodeLegacyContextEntry } from "../shared/legacy/context";

const createdAt = "2026-07-18T00:00:00.000Z";
const registration: SessionInput = {
  accessMode: "request_approval",
  compactThresholdTokens: 850_000,
  contextWindowTokens: 1_000_000,
  createdAt,
  model: "deepseek-v4-flash",
  projectRoot: "/tmp/project",
  sessionId: "session_v2",
  title: "Runtime V2"
};

test("maps each provider family to its fixed reasoning summary model", () => {
  assert.deepEqual(SUMMARY_MODEL_BY_PROVIDER, {
    deepseek: "deepseek-v4-flash",
    mock: "mock-agent",
    zhipu: "glm-5-turbo"
  });
});

function event<K extends EventType>(offset: number, type: K, data: EventPayloadMap[K], runId?: string): Event<K> {
  return {
    at: `2026-07-18T00:00:0${offset}.000Z`,
    data,
    eventId: `session_v2:${offset}`,
    offset,
    scope: { runId, sessionId: registration.sessionId },
    type,
    version: EVENT_VERSION
  } as Event<K>;
}

test("decodes a real V1 session into the V2 contract", () => {
  const decoded = decodeLegacyEvent({
    contract: "deepseeker.flow/v1",
    emittedAt: createdAt,
    offset: 1,
    payload: {
      compactThresholdTokens: 850_000,
      contextWindowTokens: 1_000_000,
      createdAt,
      model: "deepseek-v4-flash",
      permissionProfile: "smart_approval",
      projectRoot: "/tmp/project",
      sessionKey: "session_legacy",
      title: "历史会话"
    },
    scope: { sessionKey: "session_legacy" },
    signalKey: "session_legacy:1",
    topic: "session.registered"
  });
  assert.equal(decoded?.version, EVENT_VERSION);
  assert.equal(decoded?.type, "session.created");
  assert.deepEqual(decoded?.scope, { activityId: undefined, runId: undefined, sessionId: "session_legacy" });
  assert.equal((decoded?.data as SessionInput).sessionId, "session_legacy");
  assert.equal((decoded?.data as SessionInput).accessMode, "smart_approval");
});

test("normalizes V1 context identities before provider serialization", () => {
  const raw = {
    createdAt,
    cycleKey: "cycle_legacy",
    kind: "agent_text",
    recordKey: "context_legacy",
    sequence: 3,
    sessionKey: "session_legacy",
    source: "model",
    toolCalls: [{ argumentsText: '{"path":"src/App.tsx"}', callKey: "call_legacy", index: 0, name: "read_file" }]
  };
  const decoded = decodeLegacyContextEntry(raw);
  assert.equal(decoded.recordId, "context_legacy");
  assert.equal(decoded.sessionId, "session_legacy");
  assert.equal(decoded.runId, "cycle_legacy");
  assert.equal(decoded.toolCalls?.[0].callId, "call_legacy");

  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-context-v1-"));
  const database = new Database(path.join(directory, "runtime.sqlite"));
  try {
    database.raw.prepare(`INSERT INTO context_entries
      (record_id, session_id, run_id, sequence, created_at, entry_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("context_legacy", "session_legacy", "cycle_legacy", 3, createdAt, JSON.stringify(raw));
    const stored = new ContextStore(database).read("session_legacy")[0];
    assert.equal(stored.toolCalls?.[0].callId, "call_legacy");
    assert.equal(stored.recordId, "context_legacy");
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("loads V1 JSONL and deterministically settles an interrupted run", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-legacy-"));
  try {
    const signals = path.join(directory, "signals");
    mkdirSync(signals);
    const sessionId = "session_legacy";
    const runId = "run_legacy";
    const rows = [
      { contract: "deepseeker.flow/v1", emittedAt: createdAt, offset: 1, payload: { compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, createdAt, model: "deepseek-v4-flash", projectRoot: directory, sessionKey: sessionId, title: "历史会话" }, scope: { sessionKey: sessionId }, signalKey: `${sessionId}:1`, topic: "session.registered" },
      { contract: "deepseeker.flow/v1", emittedAt: createdAt, offset: 2, payload: { model: "deepseek-v4-flash", prompt: "继续工作", startedAt: createdAt }, scope: { cycleKey: runId, sessionKey: sessionId }, signalKey: `${sessionId}:2`, topic: "cycle.accepted" },
      { contract: "deepseeker.flow/v1", emittedAt: createdAt, offset: 3, payload: {}, scope: { cycleKey: runId, sessionKey: sessionId }, signalKey: `${sessionId}:3`, topic: "cycle.executing" }
    ];
    writeFileSync(path.join(signals, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const store = new RuntimeStore(directory);
    assert.equal(store.startupReport.importedLegacySessions, 1);
    assert.equal(store.startupReport.interruptedRuns, 1);
    const session = store.getSession(sessionId)!;
    assert.equal(session.title, "历史会话");
    assert.equal(session.runs[0].status, "failed");
    assert.equal(session.runs[0].resume?.failureType, "interrupted");
    assert.equal(store.readEvents(sessionId).at(-1)?.type, "run.finished");
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("commits an Event and its projection atomically", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-atomic-"));
  const database = new Database(path.join(directory, "runtime.sqlite"));
  try {
    const sessions = new SessionStore(database);
    const events = new EventStore(database, sessions);
    const created = event(1, "session.created", registration);
    database.raw.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'projection failed'); END;");
    assert.throws(() => events.append(created, createSession(registration, 1)), /projection failed/);
    assert.equal(events.count(registration.sessionId), 0);
    const row = database.raw.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("replays ordered offsets and deduplicates repeated events", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-offset-"));
  const database = new Database(path.join(directory, "runtime.sqlite"));
  try {
    const sessions = new SessionStore(database);
    const events = new EventStore(database, sessions);
    const created = event(1, "session.created", registration);
    const started = event(2, "run.started", { model: registration.model, prompt: "测试", startedAt: createdAt }, "run_v2");
    const session = createSession(registration, 1);
    events.append(created, session);
    const withRun = reduceEvent(session, started);
    events.append(started, withRun);
    events.append(started, withRun);
    assert.deepEqual(events.read(registration.sessionId, 1).map((item) => item.offset), [2]);
    assert.equal(events.count(registration.sessionId), 2);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("runs ordered migrations idempotently", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-migrate-"));
  const file = path.join(directory, "runtime.sqlite");
  try {
    const first = new Database(file);
    assert.equal(first.migrationReport.applied.length, 4);
    const count = Number((first.raw.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count);
    first.close();
    const second = new Database(file);
    assert.equal(second.migrationReport.applied.length, 0);
    const repeated = Number((second.raw.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count);
    second.close();
    assert.equal(count, 4);
    assert.equal(repeated, count);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("projects reasoning through a dedicated Run event without leaking provider field names", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-provider-boundary-"));
  try {
    writeFileSync(path.join(directory, "sample.txt"), "sample\n");
    const store = new RuntimeStore(directory);
    store.createSession({ ...registration, projectRoot: directory, sessionId: "session_provider" });
    store.append({ data: { model: registration.model, prompt: "你好", startedAt: createdAt }, runId: "run_provider", sessionId: "session_provider", type: "run.started" });
    let turn = 0;
    const provider: Provider = {
      capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: true, supportsThinking: true, supportsTools: true },
      async stream(request) {
        turn += 1;
        if (turn === 1) {
          request.onFragment?.({ kind: "thinking", text: "first private reasoning" });
          await new Promise((resolve) => setTimeout(resolve, 70));
          assert.equal(store.getRun("run_provider")?.reasoningSteps?.[0].text, "first private reasoning");
          const toolCall = {
            argumentsText: "{\"path\":\"sample.txt\"}",
            callId: "call_reasoning_read",
            index: 0,
            name: "read_file"
          };
          request.onFragment?.({ ...toolCall, kind: "tool_call" });
          return {
            answer: "",
            continuationMessage: { continuationThinking: "first private reasoning", role: "assistant", text: "", toolCalls: [toolCall] },
            finishCause: "tool_calls",
            thinking: "first private reasoning",
            toolCalls: [toolCall]
          };
        }
        request.onFragment?.({ kind: "thinking", text: "second private reasoning" });
        request.onFragment?.({ kind: "answer", text: "完成" });
        return {
          answer: "完成",
          continuationMessage: { continuationThinking: "second private reasoning", role: "assistant", text: "完成" },
          finishCause: "complete",
          thinking: "second private reasoning",
          toolCalls: []
        };
      }
    };
    const registry = new RunRegistry();
    await runAgent({ model: registration.model, projectRoot: directory, prompt: "你好", provider, registry, runId: "run_provider", sessionId: "session_provider", signal: registry.startRun("run_provider").signal, store, tools: toolHost });
    const serialized = JSON.stringify(store.readEvents("session_provider"));
    assert.ok(!serialized.includes("reasoning_content"));
    assert.ok(!serialized.includes("tool_calls"));
    assert.ok(serialized.includes("first private reasoning"));
    assert.ok(serialized.includes("second private reasoning"));
    const steps = store.getRun("run_provider")?.reasoningSteps ?? [];
    assert.equal(steps.length, 2);
    assert.equal(steps[0].text, "first private reasoning");
    assert.equal(steps[1].text, "second private reasoning");
    assert.match(steps[0].modelStepId, /^model_step_/);
    assert.match(steps[1].modelStepId, /^model_step_/);
    assert.notEqual(steps[0].modelStepId, steps[1].modelStepId);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("serves the V2 REST contract and registers the SSE transport", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-http-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
  const provider: Provider = {
    capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: true, supportsThinking: true, supportsTools: true },
    async stream() {
      return { answer: "", continuationMessage: { role: "assistant", text: "" }, finishCause: "complete", thinking: "", toolCalls: [] };
    }
  };
  const providerFor = () => ({ model: "mock-agent", provider });
  const launcher = new RunLauncher(providerFor, registry, async () => undefined, store);
  const startRun = new StartRun({
    context: defaultContextConfig,
    defaultModel: "mock-agent",
    launcher,
    store,
    system: { ...testSystem, createId: (prefix) => `${prefix}_http`, now: () => createdAt },
    workspace: { canonicalize: path.resolve, ensureScratch: (sessionId) => ensureScratchWorkspace(directory, sessionId), resolveProjectRoot: async () => directory },
    workspaceRoot: directory
  });
  const contextQueries = new ContextQueries({ capabilities: emptyCapabilitySource, context: defaultContextConfig, defaultModel: "mock-agent", rules: emptyRuleSource, store, system: { ...testSystem, createId: () => "unused", now: () => createdAt }, tools: toolHost.specs, workspaceRoot: directory });
  const app = createHttp({
    cancelRun: new CancelRun(registry, commandManager),
    config: { authToken: "runtime-test-token", context: defaultContextConfig, dataDirectory: directory, defaultModel: "mock-agent", frontendUrl: "http://127.0.0.1:5173/", hasApiKey: false, models: [], workspaceRoot: directory },
    contextQueries,
    followUps: new FollowUpService({ registry, startRun, store, system: testSystem }),
    launcher,
    providerFor,
    registry,
    sessions: new SessionService(store),
    startRun,
    store,
    workspace: new WorkspaceQueries(store, {
      describe: async (projectRoot) => ({ dirtyFiles: 0, exists: true, git: false, name: "workspace", projectRoot }),
      readText: async (projectRoot, relativePath) => ({ content: "", path: relativePath, projectRoot, truncated: false })
    })
  });
  try {
    const preflight = await app.inject({
      headers: { origin: "http://127.0.0.1:5173" },
      method: "OPTIONS",
      url: "/api/health"
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
    const rejectedOrigin = await app.inject({
      headers: { origin: "http://127.0.0.1:9999" },
      method: "OPTIONS",
      url: "/api/health"
    });
    assert.equal(rejectedOrigin.statusCode, 403);
    const unauthorized = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(unauthorized.statusCode, 401);
    const created = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { accessMode: "request_approval", model: "mock-agent", prompt: "测试 V2 API" },
      url: "/api/sessions/session_http/runs"
    });
    assert.equal(created.statusCode, 200);
    const body = created.json() as { run: { runId: string }; session: { sessionId: string; workspaceKind: string } };
    assert.match(body.run.runId, /^run_/);
    assert.equal(body.session.sessionId, "session_http");
    assert.equal(body.session.workspaceKind, "project");
    const replay = await app.inject({ headers: { authorization: "Bearer runtime-test-token" }, method: "GET", url: "/api/sessions/session_http/events?afterOffset=0" });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual((replay.json() as { events: Event[] }).events.map((item) => item.type), ["session.created", "run.started"]);
    assert.equal(app.hasRoute({ method: "GET", url: "/api/sessions/:sessionId/stream" }), true);
    assert.equal(app.hasRoute({ method: "PUT", url: "/api/sessions/:sessionId/mode" }), true);
    assert.equal(app.hasRoute({ method: "PUT", url: "/api/sessions/:sessionId/plans/:planId/revisions/:revision" }), true);
    assert.equal(app.hasRoute({ method: "POST", url: "/api/sessions/:sessionId/plans/:planId/revisions/:revision/resolve" }), true);
    assert.equal(app.hasRoute({ method: "POST", url: "/api/sessions/:sessionId/questions/:interactionId/answer" }), true);
    assert.equal(app.hasRoute({ method: "POST", url: "/api/commands/:commandId/stop" }), true);
    const missingCommand = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      url: "/api/commands/command_missing/stop"
    });
    assert.equal(missingCommand.statusCode, 404);
    assert.deepEqual(missingCommand.json(), { ok: false });
    const workspace = await app.inject({ headers: { authorization: "Bearer runtime-test-token" }, method: "GET", url: "/api/sessions/session_http/workspace" });
    assert.equal(workspace.statusCode, 200);
    assert.equal(workspace.json().workspace.exists, true);
    const scratch = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { model: "mock-agent", prompt: "临时任务", workspaceKind: "scratch" },
      url: "/api/sessions/session_scratch/runs"
    });
    assert.equal(scratch.statusCode, 200);
    const scratchSession = scratch.json().session as { projectRoot: string; workspaceKind: string };
    assert.equal(scratchSession.workspaceKind, "scratch");
    assert.equal(path.dirname(scratchSession.projectRoot), path.join(directory, "scratch-workspaces"));
    assert.equal(existsSync(scratchSession.projectRoot), true);
    const illegalScratchRoot = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { projectRoot: directory, prompt: "非法临时任务", workspaceKind: "scratch" },
      url: "/api/sessions/session_illegal_scratch/runs"
    });
    assert.equal(illegalScratchRoot.statusCode, 400);
    assert.equal(illegalScratchRoot.json().code, "invalid_input");
    const conflictingKind = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { prompt: "切换工作区", workspaceKind: "project" },
      url: "/api/sessions/session_scratch/runs"
    });
    assert.equal(conflictingKind.statusCode, 409);
    assert.equal(conflictingKind.json().code, "conflict");
    const conflictingRoot = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { projectRoot: path.join(directory, "other"), prompt: "切换项目" },
      url: "/api/sessions/session_http/runs"
    });
    assert.equal(conflictingRoot.statusCode, 409);
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cancel endpoint waits until the interrupted run has closed its context", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-cancel-drain-"));
  const store = new RuntimeStore(directory);
  const registry = new RunRegistry();
  let cleanupFinished = false;
  const provider: Provider = {
    capabilities: { contextWindowTokens: 1_000_000, supportsParallelToolCalls: true, supportsStrictTools: true, supportsThinking: true, supportsTools: true },
    async stream() {
      return { answer: "", continuationMessage: { role: "assistant", text: "" }, finishCause: "complete", thinking: "", toolCalls: [] };
    }
  };
  const providerFor = () => ({ model: "mock-agent", provider });
  const run = async (input: Parameters<RunLauncher["launch"]>[0] & { signal?: AbortSignal }) => new Promise<void>((resolve) => {
    input.signal?.addEventListener("abort", () => {
      setTimeout(() => {
        finishRun({
          answer: "运行已取消。",
          error: "用户取消了运行。",
          failureType: "cancelled",
          projectRoot: input.projectRoot,
          runId: input.runId,
          sessionId: input.sessionId,
          status: "cancelled",
          store,
          system: testSystem
        });
        cleanupFinished = true;
        resolve();
      }, 25);
    }, { once: true });
  });
  const launcher = new RunLauncher(providerFor, registry, run, store);
  const startRun = new StartRun({
    context: defaultContextConfig,
    defaultModel: "mock-agent",
    launcher,
    store,
    system: { ...testSystem, createId: (prefix) => `${prefix}_cancel`, now: () => createdAt },
    workspace: { canonicalize: path.resolve, ensureScratch: (sessionId) => ensureScratchWorkspace(directory, sessionId), resolveProjectRoot: async () => directory },
    workspaceRoot: directory
  });
  const contextQueries = new ContextQueries({ capabilities: emptyCapabilitySource, context: defaultContextConfig, defaultModel: "mock-agent", rules: emptyRuleSource, store, system: { ...testSystem, createId: () => "unused", now: () => createdAt }, tools: toolHost.specs, workspaceRoot: directory });
  const app = createHttp({
    cancelRun: new CancelRun(registry, commandManager),
    config: { authToken: "runtime-test-token", context: defaultContextConfig, dataDirectory: directory, defaultModel: "mock-agent", frontendUrl: "http://127.0.0.1:5173/", hasApiKey: false, models: [], workspaceRoot: directory },
    contextQueries,
    followUps: new FollowUpService({ registry, startRun, store, system: testSystem }),
    launcher,
    providerFor,
    registry,
    sessions: new SessionService(store),
    startRun,
    store,
    workspace: new WorkspaceQueries(store, {
      describe: async (projectRoot) => ({ dirtyFiles: 0, exists: true, git: false, name: "workspace", projectRoot }),
      readText: async (projectRoot, relativePath) => ({ content: "", path: relativePath, projectRoot, truncated: false })
    })
  });

  try {
    const created = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      payload: { accessMode: "full_access", model: "mock-agent", prompt: "执行任务" },
      url: "/api/sessions/session_cancel_drain/runs"
    });
    const runId = (created.json() as { run: { runId: string } }).run.runId;
    const cancelled = await app.inject({
      headers: { authorization: "Bearer runtime-test-token" },
      method: "POST",
      url: `/api/runs/${runId}/cancel`
    });

    assert.equal(cancelled.statusCode, 200);
    assert.deepEqual(cancelled.json(), { ok: true, settled: true });
    assert.equal(cleanupFinished, true);
    assert.equal(store.getRun(runId)?.status, "cancelled");
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
