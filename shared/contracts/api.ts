import { ContextStats } from "./context";
import { ModelOption, ProviderBalance } from "./provider";
import { PlanEntry, Session, SessionSummary } from "./runtime";

export type RuntimeConfig = {
  compactThresholdTokens: number;
  contextWindowTokens: number;
  effectiveInputBudgetTokens: number;
  requestedMaxOutputTokens: number;
  contextPreview?: ContextStats;
  defaultModel: string;
  hasApiKey: boolean;
  eventContract: string;
  evalsEnabled?: boolean;
  models: ModelOption[];
  planEntry: PlanEntry;
  workspaceRoot: string;
};

export type RuntimeBalance = ProviderBalance;
export type RuntimeContextTelemetry = ContextStats;

export type RuntimeContextObserver = {
  latest?: ContextStats;
  memoryFactCount: number;
  recent: ContextStats[];
  sessionId: string;
  updates: Array<{
    createdAt: string;
    kind: string;
    label: string;
    loadingReason?: string;
    recordId?: string;
    revisionHash?: string;
    source?: string;
    survivesCompaction?: boolean;
    trust?: string;
  }>;
};

export type RuntimeFilePreview = {
  content: string;
  path: string;
  projectRoot: string;
  truncated: boolean;
};

export type RuntimeWorkspace = {
  branch?: string;
  dirtyFiles: number;
  exists: boolean;
  git: boolean;
  name: string;
  projectRoot: string;
};

export type RuntimeErrorResponse = {
  code?: string;
  error: string;
};

export type OkResponse = { ok: boolean; settled?: boolean };
export type SessionResponse = { session: Session };
export type SessionsResponse = { sessions: SessionSummary[] };
export type WorkspaceResponse = { workspace: RuntimeWorkspace };
export type ContextObserverResponse = { observer: RuntimeContextObserver };
export type ArchiveSessionsResponse = { archived: number };
export type InteractionResponse = { idempotent: boolean; session: Session };
