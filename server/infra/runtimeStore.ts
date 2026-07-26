import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  EVENT_VERSION,
  Event,
  EventType,
  Run,
  Session,
  SessionInput,
  SessionSummary
} from "../../shared/contracts/runtime";
import { createSession, rebuildSession, reduceEvent } from "../../shared/domain/reducer";
import { assertEventTransition } from "../../shared/domain/state";
import { decodeEvent } from "../../shared/legacy/decoder";
import { ContextEntry, ContextStats, MemoryFact, ContextInput } from "../../shared/contracts/context";
import { ContextStore } from "./contextStore";
import { Database } from "./database";
import { EventStore } from "./eventStore";
import { EvidenceStore } from "./evidenceStore";
import { MemoryStore } from "./memoryStore";
import { MetricStore } from "./metricStore";
import { SessionStore } from "./sessionStore";
import { createContextEntry } from "./contextEntry";
import {
  ContextPort,
  EventInput,
  EventPort,
  EventSubscriber,
  EvidencePort,
  MemoryPort,
  MetricPort,
  SessionPort,
  StoreLifecyclePort
} from "../app/runtimeRepo";
import { recoverRuntimeState, RuntimeRecoveryReport } from "../app/runtimeRecovery";
import { MigrationReport } from "./database";
import { SystemPort } from "../app/systemPort";
import { nodeSystem } from "./system";

export type RuntimeStoreStartupReport = RuntimeRecoveryReport & {
  importedLegacySessions: number;
  migrations: MigrationReport;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class RuntimeStore implements EventPort, SessionPort, ContextPort, EvidencePort, MemoryPort, MetricPort, StoreLifecyclePort {
  readonly startupReport: RuntimeStoreStartupReport;
  private readonly contexts: ContextStore;
  private readonly database: Database;
  private readonly events: EventStore;
  private readonly evidence: EvidenceStore;
  private readonly memories: MemoryStore;
  private readonly metrics: MetricStore;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionStore: SessionStore;
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();

  constructor(private readonly dataDirectory: string, migrationDirectory?: string, system: SystemPort = nodeSystem) {
    mkdirSync(dataDirectory, { recursive: true });
    this.database = new Database(path.join(dataDirectory, "runtime.sqlite"), migrationDirectory);
    this.sessionStore = new SessionStore(this.database);
    this.events = new EventStore(this.database, this.sessionStore);
    this.contexts = new ContextStore(this.database);
    this.memories = new MemoryStore(this.database);
    this.metrics = new MetricStore(this.database);
    this.evidence = new EvidenceStore(this.database, dataDirectory);
    for (const session of this.sessionStore.all()) this.sessions.set(session.sessionId, session);
    const importedLegacySessions = this.importLegacyLogs();
    const recovery = recoverRuntimeState(this, [...this.sessions.values()].map(clone), system);
    this.startupReport = {
      importedLegacySessions,
      migrations: this.database.migrationReport,
      ...recovery
    };
  }

  createSession(input: Omit<SessionInput, "createdAt">): Session {
    const existing = this.sessions.get(input.sessionId);
    if (existing) return clone(existing);
    const at = new Date().toISOString();
    const registration: SessionInput = { ...input, createdAt: at };
    const event: Event<"session.created"> = {
      at,
      data: registration,
      eventId: `${input.sessionId}:1`,
      offset: 1,
      scope: { sessionId: input.sessionId },
      type: "session.created",
      version: EVENT_VERSION
    };
    const session = createSession(registration, 1);
    this.events.append(event, session);
    this.sessions.set(input.sessionId, session);
    this.publish(input.sessionId, [event]);
    return clone(session);
  }

  append<K extends Exclude<EventType, "session.created">>(input: EventInput<K>): Event<K> {
    const current = this.sessions.get(input.sessionId);
    if (!current) throw new Error(`Session not found: ${input.sessionId}`);
    const scope = { activityId: input.activityId, runId: input.runId, sessionId: input.sessionId };
    assertEventTransition(current, { data: input.data, scope, type: input.type });
    const offset = current.lastOffset + 1;
    const event = {
      at: new Date().toISOString(),
      data: input.data,
      eventId: `${input.sessionId}:${offset}`,
      offset,
      scope,
      type: input.type,
      version: EVENT_VERSION
    } as Event<K>;
    const next = reduceEvent(current, event);
    this.events.append(event, next);
    this.sessions.set(input.sessionId, next);
    this.publish(input.sessionId, [event]);
    return clone(event);
  }

  appendMany(inputs: EventInput[]): Event[] {
    if (inputs.length === 0) return [];
    const sessionId = inputs[0].sessionId;
    if (inputs.some((input) => input.sessionId !== sessionId)) throw new Error("A committed Event batch must belong to one Session.");
    let session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const events: Event[] = [];
    for (const input of inputs) {
      const scope = { activityId: input.activityId, runId: input.runId, sessionId };
      assertEventTransition(session, { data: input.data, scope, type: input.type });
      const offset = session.lastOffset + 1;
      const event = {
        at: new Date().toISOString(),
        data: input.data,
        eventId: `${sessionId}:${offset}`,
        offset,
        scope,
        type: input.type,
        version: EVENT_VERSION
      } as Event;
      session = reduceEvent(session, event);
      events.push(event);
    }
    this.events.appendMany(events, session);
    this.sessions.set(sessionId, session);
    this.publish(sessionId, events);
    return clone(events);
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : undefined;
  }

  getRun(runId: string): Run | undefined {
    for (const session of this.sessions.values()) {
      const run = session.runs.find((item) => item.runId === runId);
      if (run) return clone(run);
    }
    return undefined;
  }

  listSessions(query = ""): SessionSummary[] {
    return this.sessionStore.list(query);
  }

  archiveProjectSessions(projectRoot: string): number {
    return this.sessionStore.archiveProject(projectRoot);
  }

  updateSessionSidebar(sessionId: string, input: { archived?: boolean; pinned?: boolean }): boolean {
    return this.sessionStore.updateSidebarState(sessionId, input);
  }

  readEvents(sessionId: string, afterOffset = 0): Event[] {
    return this.events.read(sessionId, afterOffset);
  }

  subscribe(sessionId: string, subscriber: EventSubscriber): () => void {
    const listeners = this.subscribers.get(sessionId) ?? new Set<EventSubscriber>();
    listeners.add(subscriber);
    this.subscribers.set(sessionId, listeners);
    return () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.subscribers.delete(sessionId);
    };
  }

  appendContextEntry(input: ContextInput): ContextEntry {
    if (!this.sessions.has(input.sessionId)) throw new Error(`Session not found: ${input.sessionId}`);
    this.ensureLegacyContext(input.sessionId);
    return this.contexts.append(input);
  }

  readContextEntries(sessionId: string): ContextEntry[] {
    this.ensureLegacyContext(sessionId);
    return this.contexts.read(sessionId);
  }

  storeEvidence(sessionId: string, recordId: string, text: string): string {
    return this.evidence.writeArtifact(sessionId, recordId, text);
  }

  writeDebugSnapshot(sessionId: string, runId: string, value: unknown): void {
    this.evidence.writeDebug(sessionId, runId, value);
  }

  recordMetric(metric: ContextStats): void {
    this.metrics.save(metric);
  }

  updateMetricUsage(metricId: string, usage: Pick<ContextStats, "actualInputTokens" | "outputTokens" | "cacheHitTokens" | "cacheMissTokens">): void {
    this.metrics.updateUsage(metricId, usage);
  }

  readMetrics(sessionId: string): ContextStats[] {
    return this.metrics.read(sessionId);
  }

  readCalibration(model: string): number {
    return this.metrics.calibration(model);
  }

  saveMemory(input: Omit<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId"> & Partial<Pick<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId">>): MemoryFact {
    return this.memories.save(input);
  }

  readMemories(projectRoot?: string): MemoryFact[] {
    return this.memories.read(projectRoot);
  }

  memoryDigest(projectRoot: string, limit = 12): string {
    const facts = this.readMemories(projectRoot).slice(0, Math.min(30, Math.max(1, limit)));
    if (facts.length === 0) return "当前没有生效的结构化记忆事实。";
    return facts.map((fact) => `${fact.memoryId}\t${fact.category}\t${fact.visibility}\t${fact.confidence.toFixed(2)}\t${fact.statement.slice(0, 220)}`).join("\n");
  }

  deleteMemory(memoryId: string): boolean {
    return this.memories.delete(memoryId);
  }

  close(): void {
    this.database.close();
  }

  private importLegacyLogs(): number {
    const directory = path.join(this.dataDirectory, "signals");
    if (!existsSync(directory)) return 0;
    let imported = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      if (this.events.count(sessionId) > 0) continue;
      const events = readFileSync(path.join(directory, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeEvent(JSON.parse(line)))
        .filter((event): event is Event => Boolean(event));
      const session = rebuildSession(events);
      if (!session) continue;
      this.events.import(events, session);
      this.sessions.set(sessionId, session);
      imported += 1;
    }
    return imported;
  }

  private ensureLegacyContext(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const covered = this.contexts.runIds(sessionId);
    let sequence = this.contexts.read(sessionId).at(-1)?.sequence ?? 0;
    for (const run of session.runs) {
      if (covered.has(run.runId) || !["completed", "failed", "cancelled"].includes(run.status)) continue;
      const inputs: ContextInput[] = [{
        createdAt: run.startedAt,
        kind: "human_text",
        recordId: `legacy_${run.runId}_human`,
        runId: run.runId,
        sessionId,
        source: "legacy_projection",
        text: run.prompt
      }];
      if (run.answer || run.error) inputs.push({
        createdAt: run.finishedAt ?? run.startedAt,
        isError: run.status !== "completed",
        kind: "agent_text",
        recordId: `legacy_${run.runId}_agent`,
        runId: run.runId,
        sessionId,
        source: "legacy_projection",
        text: run.answer || run.error
      });
      for (const input of inputs) {
        const entry = createContextEntry(input, sequence += 1);
        this.database.raw.prepare(`INSERT OR IGNORE INTO context_entries
          (record_id, session_id, run_id, sequence, created_at, entry_json)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(entry.recordId, sessionId, entry.runId ?? null, entry.sequence, entry.createdAt, JSON.stringify(entry));
      }
    }
  }

  private publish(sessionId: string, events: Event[]): void {
    this.subscribers.get(sessionId)?.forEach((subscriber) => subscriber(clone(events)));
  }
}
