import { ContextEntry, ContextInput, ContextStats, MemoryFact } from "../../shared/contracts/context";
import { Delegation, Event, EventPayloadMap, EventType, Run, Session, SessionInput, SessionSummary } from "../../shared/contracts/runtime";

export type EventSubscriber = (events: Event[]) => void;

export type EventInput<K extends EventType = EventType> = K extends EventType ? {
  activityId?: string;
  data: EventPayloadMap[K];
  runId?: string;
  sessionId: string;
  type: Exclude<K, "session.created">;
} : never;

export interface EventPort {
  append<K extends Exclude<EventType, "session.created">>(input: EventInput<K>): Event<K>;
  appendMany(inputs: EventInput[]): Event[];
  readEvents(sessionId: string, afterOffset?: number): Event[];
  subscribe(sessionId: string, subscriber: EventSubscriber): () => void;
}

export interface SessionPort {
  archiveProjectSessions(projectRoot: string): number;
  createSession(input: Omit<SessionInput, "createdAt">): Session;
  deleteSession(sessionId: string): boolean;
  getRun(runId: string): Run | undefined;
  getSession(sessionId: string): Session | undefined;
  listSessions(query?: string): SessionSummary[];
  updateSessionSidebar(sessionId: string, input: { archived?: boolean; pinned?: boolean }): boolean;
}

export interface DelegationPort {
  createDelegatedRun(input: {
    childRun: EventPayloadMap["run.started"] & { runId: string };
    childSession: Omit<SessionInput, "createdAt">;
    delegation: Delegation;
  }): { childSession: Session; parentSession: Session };
}

export interface ContextPort {
  appendContextEntry(input: ContextInput): ContextEntry;
  readContextEntries(sessionId: string): ContextEntry[];
}

export interface AtomicWritePort {
  appendAtomically(inputs: EventInput[], contextInputs: ContextInput[]): {
    contextEntries: ContextEntry[];
    events: Event[];
  };
}

export interface EvidencePort {
  storeEvidence(sessionId: string, recordId: string, text: string): string;
  writeDebugSnapshot(sessionId: string, runId: string, value: unknown): void;
}

export interface MemoryPort {
  deleteMemory(memoryId: string): boolean;
  memoryDigest(projectRoot: string, limit?: number): string;
  readMemories(projectRoot?: string): MemoryFact[];
  saveMemory(input: Omit<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId"> & Partial<Pick<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId">>): MemoryFact;
}

export interface MetricPort {
  readCalibration(model: string): number;
  readMetrics(sessionId: string): ContextStats[];
  recordMetric(metric: ContextStats): void;
  updateMetricUsage(metricId: string, usage: Pick<ContextStats, "actualInputTokens" | "outputTokens" | "cacheHitTokens" | "cacheMissTokens">): void;
}

export interface StoreLifecyclePort {
  close(): void;
}

export type RuntimePorts = AtomicWritePort & EventPort & SessionPort & DelegationPort & ContextPort & EvidencePort & MemoryPort & MetricPort & StoreLifecyclePort;
