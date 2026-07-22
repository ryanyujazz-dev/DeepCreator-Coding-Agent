import { ContextEntry, ContextInput, ContextStats, MemoryFact } from "../../shared/contracts/context";
import { Event, EventType, Run, Session, SessionInput, SessionSummary } from "../../shared/contracts/runtime";

export type EventSubscriber = (events: Event[]) => void;

export interface RuntimeRepo {
  append<T>(input: {
    activityId?: string;
    data: T;
    runId?: string;
    sessionId: string;
    type: Exclude<EventType, "session.created">;
  }): Event<T>;
  appendMany(inputs: Array<{
    activityId?: string;
    data: unknown;
    runId?: string;
    sessionId: string;
    type: Exclude<EventType, "session.created">;
  }>): Event[];
  appendContextEntry(input: ContextInput): ContextEntry;
  archiveProjectSessions(projectRoot: string): number;
  close(): void;
  createSession(input: Omit<SessionInput, "createdAt">): Session;
  deleteMemory(memoryId: string): boolean;
  getRun(runId: string): Run | undefined;
  getSession(sessionId: string): Session | undefined;
  listSessions(query?: string): SessionSummary[];
  memoryDigest(projectRoot: string, limit?: number): string;
  readCalibration(model: string): number;
  readContextEntries(sessionId: string): ContextEntry[];
  readEvents(sessionId: string, afterOffset?: number): Event[];
  readMemories(projectRoot?: string): MemoryFact[];
  readMetrics(sessionId: string): ContextStats[];
  recordMetric(metric: ContextStats): void;
  saveMemory(input: Omit<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId"> & Partial<Pick<MemoryFact, "createdAt" | "lastConfirmedAt" | "memoryId">>): MemoryFact;
  storeEvidence(sessionId: string, recordId: string, text: string): string;
  subscribe(sessionId: string, subscriber: EventSubscriber): () => void;
  updateSessionSidebar(sessionId: string, input: { archived?: boolean; pinned?: boolean }): boolean;
  updateMetricUsage(metricId: string, usage: Pick<ContextStats, "actualInputTokens" | "outputTokens" | "cacheHitTokens" | "cacheMissTokens">): void;
  writeDebugSnapshot(sessionId: string, runId: string, value: unknown): void;
}
