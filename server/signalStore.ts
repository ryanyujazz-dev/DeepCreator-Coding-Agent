import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
  private readonly logDirectory: string;
  private readonly sessions = new Map<string, WorkspaceSessionView>();
  private readonly subscribers = new Map<string, Set<SignalSubscriber>>();

  constructor(dataDirectory: string) {
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
