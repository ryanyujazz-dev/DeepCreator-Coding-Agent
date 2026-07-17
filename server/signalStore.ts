import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentSignal,
  CycleView,
  SessionListEntry,
  SessionRegistration,
  SIGNAL_CONTRACT,
  SignalTopic,
  WorkspaceSessionView
} from "../shared/runtimeTypes";
import { createSessionView, rebuildSession, reduceSignal } from "../shared/signalReducer";
import { assertSignalTransition } from "../shared/signalStateMachine";
import { settleWorkCycle } from "./cycleLifecycle";
import {
  ContextRecord,
  ContextTelemetry,
  NewContextRecord,
  createContextRecord
} from "./contextRecords";

type SignalSubscriber = (signals: AgentSignal[]) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeLogName(sessionKey: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionKey)) throw new Error("Invalid session key.");
  return `${sessionKey}.jsonl`;
}

export class SignalStore {
  private readonly database: DatabaseSync;
  private readonly dataDirectory: string;
  private readonly logDirectory: string;
  private readonly sessions = new Map<string, WorkspaceSessionView>();
  private readonly subscribers = new Map<string, Set<SignalSubscriber>>();

  constructor(dataDirectory: string) {
    this.dataDirectory = dataDirectory;
    mkdirSync(dataDirectory, { recursive: true });
    this.logDirectory = path.join(dataDirectory, "signals");
    mkdirSync(this.logDirectory, { recursive: true });
    this.database = new DatabaseSync(path.join(dataDirectory, "runtime.sqlite"));
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_views (
        session_key TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        project_root TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        view_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cycle_views (
        cycle_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at TEXT NOT NULL,
        view_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cycle_views_session_idx ON cycle_views(session_key, started_at);
      CREATE TABLE IF NOT EXISTS signal_index (
        signal_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        cycle_key TEXT,
        offset INTEGER NOT NULL,
        topic TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        UNIQUE(session_key, offset)
      );
      CREATE TABLE IF NOT EXISTS context_records (
        record_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        cycle_key TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(session_key, sequence)
      );
      CREATE INDEX IF NOT EXISTS context_records_session_idx
        ON context_records(session_key, sequence);
      CREATE TABLE IF NOT EXISTS context_telemetry (
        telemetry_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        cycle_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        telemetry_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_telemetry_session_idx
        ON context_telemetry(session_key, created_at);
    `);
    this.ensureSessionColumn("title", "TEXT NOT NULL DEFAULT ''");
    this.ensureSessionColumn("project_root", "TEXT NOT NULL DEFAULT ''");
    this.ensureSessionColumn("search_text", "TEXT NOT NULL DEFAULT ''");
    this.loadAndReconcile();
    this.settleInterruptedCycles();
  }

  registerSession(input: Omit<SessionRegistration, "createdAt">): WorkspaceSessionView {
    if (this.sessions.has(input.sessionKey)) return this.getSession(input.sessionKey)!;
    const createdAt = new Date().toISOString();
    const registration: SessionRegistration = { ...input, createdAt };
    const signal: AgentSignal<SessionRegistration> = {
      contract: SIGNAL_CONTRACT,
      emittedAt: createdAt,
      offset: 1,
      payload: registration,
      scope: { sessionKey: input.sessionKey },
      signalKey: `${input.sessionKey}:1`,
      topic: "session.registered"
    };
    const view = createSessionView(registration, 1);
    this.appendLog(signal);
    this.sessions.set(input.sessionKey, view);
    this.persist(signal, view);
    this.publish(input.sessionKey, [signal]);
    return clone(view);
  }

  append<TPayload>(input: {
    sessionKey: string;
    cycleKey?: string;
    unitKey?: string;
    topic: Exclude<SignalTopic, "session.registered">;
    payload: TPayload;
  }): AgentSignal<TPayload> {
    const current = this.sessions.get(input.sessionKey);
    if (!current) throw new Error(`WorkspaceSession not found: ${input.sessionKey}`);
    const draft = {
      payload: input.payload,
      scope: {
        cycleKey: input.cycleKey,
        sessionKey: input.sessionKey,
        unitKey: input.unitKey
      },
      topic: input.topic
    };
    assertSignalTransition(current, draft);
    const offset = current.lastOffset + 1;
    const signal: AgentSignal<TPayload> = {
      contract: SIGNAL_CONTRACT,
      emittedAt: new Date().toISOString(),
      offset,
      payload: input.payload,
      scope: draft.scope,
      signalKey: `${input.sessionKey}:${offset}`,
      topic: input.topic
    };
    const next = reduceSignal(current, signal);
    this.appendLog(signal);
    this.sessions.set(input.sessionKey, next);
    this.persist(signal, next);
    this.publish(input.sessionKey, [signal]);
    return clone(signal);
  }

  getSession(sessionKey: string): WorkspaceSessionView | undefined {
    const view = this.sessions.get(sessionKey);
    return view ? clone(view) : undefined;
  }

  getCycle(cycleKey: string): CycleView | undefined {
    for (const session of this.sessions.values()) {
      const cycle = session.cycles.find((item) => item.cycleKey === cycleKey);
      if (cycle) return clone(cycle);
    }
    return undefined;
  }

  appendContextRecord(input: NewContextRecord): ContextRecord {
    if (!this.sessions.has(input.sessionKey)) throw new Error(`WorkspaceSession not found: ${input.sessionKey}`);
    this.ensureLegacyContextRecords(input.sessionKey);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM context_records WHERE session_key = ?")
      .get(input.sessionKey) as { sequence: number };
    const record = createContextRecord(input, Number(row.sequence) + 1);
    this.database
      .prepare(`INSERT INTO context_records
        (record_key, session_key, cycle_key, sequence, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        record.recordKey,
        record.sessionKey,
        record.cycleKey ?? null,
        record.sequence,
        record.createdAt,
        JSON.stringify(record)
      );
    return clone(record);
  }

  readContextRecords(sessionKey: string): ContextRecord[] {
    this.ensureLegacyContextRecords(sessionKey);
    const rows = this.database
      .prepare("SELECT record_json FROM context_records WHERE session_key = ? ORDER BY sequence")
      .all(sessionKey) as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as ContextRecord);
  }

  storeContextArtifact(sessionKey: string, recordKey: string, text: string): string {
    const directory = path.join(this.dataDirectory, "context-artifacts", safeLogName(sessionKey).replace(/\.jsonl$/, ""));
    mkdirSync(directory, { recursive: true });
    const safeRecordKey = recordKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(path.join(directory, `${safeRecordKey}.txt`), text, "utf8");
    return `context-artifact://${sessionKey}/${safeRecordKey}`;
  }

  recordContextTelemetry(telemetry: ContextTelemetry): void {
    this.database
      .prepare(`INSERT INTO context_telemetry
        (telemetry_key, session_key, cycle_key, created_at, telemetry_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(telemetry_key) DO UPDATE SET telemetry_json = excluded.telemetry_json`)
      .run(
        telemetry.telemetryKey,
        telemetry.sessionKey,
        telemetry.cycleKey,
        telemetry.createdAt,
        JSON.stringify(telemetry)
      );
  }

  updateContextTelemetryUsage(
    telemetryKey: string,
    usage: Pick<ContextTelemetry, "actualInputTokens" | "outputTokens" | "cacheHitTokens" | "cacheMissTokens">
  ): void {
    const row = this.database
      .prepare("SELECT telemetry_json FROM context_telemetry WHERE telemetry_key = ?")
      .get(telemetryKey) as { telemetry_json: string } | undefined;
    if (!row) return;
    const telemetry = { ...JSON.parse(row.telemetry_json), ...usage } as ContextTelemetry;
    this.recordContextTelemetry(telemetry);
  }

  readContextTelemetry(sessionKey: string): ContextTelemetry[] {
    return (this.database
      .prepare("SELECT telemetry_json FROM context_telemetry WHERE session_key = ? ORDER BY created_at")
      .all(sessionKey) as Array<{ telemetry_json: string }>)
      .map((row) => JSON.parse(row.telemetry_json) as ContextTelemetry);
  }

  writeContextDebugSnapshot(sessionKey: string, cycleKey: string, value: unknown): void {
    if (process.env.NODE_ENV === "production" || process.env.DEEPSEEK_CONTEXT_DEBUG !== "1") return;
    const directory = path.join(this.dataDirectory, "context-debug", safeLogName(sessionKey).replace(/\.jsonl$/, ""));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${cycleKey}.json`), JSON.stringify(value, null, 2), "utf8");
  }

  listSessions(query = ""): SessionListEntry[] {
    const normalized = query.trim().toLowerCase();
    const rows = normalized
      ? this.database
          .prepare("SELECT view_json FROM session_views WHERE lower(search_text) LIKE ? ORDER BY updated_at DESC")
          .all(`%${normalized}%`)
      : this.database.prepare("SELECT view_json FROM session_views ORDER BY updated_at DESC").all();
    return rows
      .map((row) => JSON.parse(String((row as { view_json: string }).view_json)) as WorkspaceSessionView)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        active: session.cycles.some((cycle) => cycle.phase === "active" || cycle.phase === "awaiting_approval"),
        createdAt: session.createdAt,
        cycleCount: session.cycles.length,
        model: session.model,
        projectRoot: session.projectRoot,
        sessionKey: session.sessionKey,
        title: session.title,
        updatedAt: session.updatedAt
      }));
  }

  readSignals(sessionKey: string, afterOffset = 0): AgentSignal[] {
    const logPath = this.logPath(sessionKey);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentSignal)
      .filter((signal) => signal.offset > afterOffset);
  }

  subscribe(sessionKey: string, subscriber: SignalSubscriber): () => void {
    const listeners = this.subscribers.get(sessionKey) ?? new Set<SignalSubscriber>();
    listeners.add(subscriber);
    this.subscribers.set(sessionKey, listeners);
    return () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.subscribers.delete(sessionKey);
    };
  }

  close(): void {
    this.database.close();
  }

  private logPath(sessionKey: string): string {
    return path.join(this.logDirectory, safeLogName(sessionKey));
  }

  private appendLog(signal: AgentSignal): void {
    appendFileSync(this.logPath(signal.scope.sessionKey), `${JSON.stringify(signal)}\n`, "utf8");
  }

  private persist(signal: AgentSignal, view: WorkspaceSessionView): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`INSERT OR IGNORE INTO signal_index
          (signal_key, session_key, cycle_key, offset, topic, emitted_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          signal.signalKey,
          signal.scope.sessionKey,
          signal.scope.cycleKey ?? null,
          signal.offset,
          signal.topic,
          signal.emittedAt
        );
      const searchText = [
        view.title,
        view.projectRoot,
        ...view.cycles.flatMap((cycle) => [
          cycle.prompt,
          cycle.finalResponse,
          ...cycle.plan.map((step) => step.label),
          ...cycle.workspaceDelta.files.map((file) => file.path)
        ])
      ].join("\n");
      this.database
        .prepare(`INSERT INTO session_views
          (session_key, title, project_root, search_text, updated_at, view_json) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            title = excluded.title,
            project_root = excluded.project_root,
            search_text = excluded.search_text,
            updated_at = excluded.updated_at,
            view_json = excluded.view_json`)
        .run(view.sessionKey, view.title, view.projectRoot, searchText, view.updatedAt, JSON.stringify(view));
      if (signal.scope.cycleKey) {
        const cycle = view.cycles.find((item) => item.cycleKey === signal.scope.cycleKey);
        if (cycle) {
          this.database
            .prepare(`INSERT INTO cycle_views (cycle_key, session_key, phase, started_at, view_json)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(cycle_key) DO UPDATE SET phase = excluded.phase, view_json = excluded.view_json`)
            .run(cycle.cycleKey, cycle.sessionKey, cycle.phase, cycle.startedAt, JSON.stringify(cycle));
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private loadAndReconcile(): void {
    for (const fileName of readdirSync(this.logDirectory)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const sessionKey = fileName.slice(0, -".jsonl".length);
      const signals = this.readSignals(sessionKey);
      const rebuilt = rebuildSession(signals);
      if (!rebuilt) continue;
      this.sessions.set(sessionKey, rebuilt);
      const finalSignal = signals.at(-1);
      if (finalSignal) this.persist(finalSignal, rebuilt);
    }
  }

  private ensureSessionColumn(name: string, definition: string): void {
    const columns = this.database.prepare("PRAGMA table_info(session_views)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.database.exec(`ALTER TABLE session_views ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureLegacyContextRecords(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    const coveredRows = this.database
      .prepare("SELECT DISTINCT cycle_key FROM context_records WHERE session_key = ? AND cycle_key IS NOT NULL")
      .all(sessionKey) as Array<{ cycle_key: string }>;
    const coveredCycles = new Set(coveredRows.map((row) => row.cycle_key));
    let sequence = Number((this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM context_records WHERE session_key = ?")
      .get(sessionKey) as { sequence: number }).sequence);
    for (const cycle of session.cycles) {
      if (coveredCycles.has(cycle.cycleKey) || !["succeeded", "failed", "cancelled"].includes(cycle.phase)) continue;
      const inputs: NewContextRecord[] = [{
        createdAt: cycle.startedAt,
        cycleKey: cycle.cycleKey,
        kind: "human_text",
        recordKey: `legacy_${cycle.cycleKey}_human`,
        sessionKey,
        source: "legacy_projection",
        text: cycle.prompt
      }];
      if (cycle.finalResponse || cycle.failure) {
        inputs.push({
          createdAt: cycle.settledAt ?? cycle.startedAt,
          cycleKey: cycle.cycleKey,
          isError: cycle.phase !== "succeeded",
          kind: "agent_text",
          recordKey: `legacy_${cycle.cycleKey}_agent`,
          sessionKey,
          source: "legacy_projection",
          text: cycle.finalResponse || cycle.failure
        });
      }
      for (const input of inputs) {
        const record = createContextRecord(input, sequence += 1);
        this.database.prepare(`INSERT OR IGNORE INTO context_records
          (record_key, session_key, cycle_key, sequence, created_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(record.recordKey, sessionKey, record.cycleKey ?? null, record.sequence, record.createdAt, JSON.stringify(record));
      }
    }
  }

  private settleInterruptedCycles(): void {
    for (const session of [...this.sessions.values()]) {
      for (const cycle of session.cycles) {
        if (cycle.phase !== "active" && cycle.phase !== "awaiting_approval" && cycle.phase !== "queued") continue;
        settleWorkCycle({
          cycleKey: cycle.cycleKey,
          failure: "Runtime restarted before this work cycle reached a terminal state.",
          failureType: "interrupted",
          finalResponse: "上一次运行因 Runtime 重启而中断。",
          phase: "failed",
          projectRoot: session.projectRoot,
          sessionKey: session.sessionKey,
          store: this
        });
      }
    }
  }

  private publish(sessionKey: string, signals: AgentSignal[]): void {
    this.subscribers.get(sessionKey)?.forEach((subscriber) => subscriber(clone(signals)));
  }
}
