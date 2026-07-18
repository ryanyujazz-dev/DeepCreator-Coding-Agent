import { Event, ApprovalChoice, AccessMode, EventStream, Mode, Plan, PlanDecision, PlanEntry, Session } from "../shared/contracts/runtime";

export class RuntimeRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body || `Request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.message || parsed.error || message;
    } catch {
      // Keep the plain body when the server does not return JSON.
    }
    throw new RuntimeRequestError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export type RuntimeConfig = {
  compactThresholdTokens: number;
  contextWindowTokens: number;
  effectiveInputBudgetTokens: number;
  requestedMaxOutputTokens: number;
  contextPreview?: RuntimeContextTelemetry;
  defaultModel: string;
  hasApiKey: boolean;
  eventContract: string;
  planEntry: PlanEntry;
};

export type RuntimeContextSection = {
  section: string;
  source: string;
  estimatedTokens: number;
  cacheClass: string;
  role?: string;
  survivesCompaction?: boolean;
};

export type RuntimeContextTelemetry = {
  metricId: string;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  prefixHash: string;
  compacted: boolean;
  compactThresholdTokens?: number;
  effectiveInputBudgetTokens?: number;
  providerContextWindowTokens?: number;
  requestedMaxOutputTokens?: number;
  sections: RuntimeContextSection[];
  truncationEvents?: Array<{ recordId: string; toolName?: string }>;
  events?: Array<{ kind: string; label: string; source?: string }>;
};

export type RuntimeContextObserver = {
  latest?: RuntimeContextTelemetry;
  memoryFactCount: number;
  recent: RuntimeContextTelemetry[];
  sessionId: string;
  updates: Array<{
    createdAt: string;
    kind: string;
    label: string;
    loadingReason?: string;
    source?: string;
  }>;
};

export type RuntimeFilePreview = {
  content: string;
  path: string;
  projectRoot: string;
  truncated: boolean;
};

export const runtimeApi = {
  config: () => fetch("/api/config").then((response) => json<RuntimeConfig>(response)),
  listSessions: (query = "") =>
    fetch(`/api/sessions${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`).then((response) =>
      json<{ sessions: import("../shared/contracts/runtime").SessionSummary[] }>(response)
    ),
  getSession: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`).then((response) =>
      json<{ session: Session }>(response)
    ),
  getContextObserver: (sessionId: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-observer`).then((response) =>
      json<{ observer: RuntimeContextObserver }>(response)
    ),
  getFile: (sessionId: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`).then((response) =>
      json<RuntimeFilePreview>(response)
    ),
  startRun: (input: { model: string; accessMode: AccessMode; mode: Mode; planEntry: PlanEntry; prompt: string; sessionId?: string }) => {
    const sessionId = input.sessionId ?? `session_${crypto.randomUUID()}`;
    return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ session: Session }>(response));
  },
  cancelRun: (runId: string) =>
    fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).then((response) =>
      json<{ ok: boolean }>(response)
    ),
  setAccessMode: (sessionId: string, accessMode: AccessMode) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/access-mode`, {
      body: JSON.stringify({ accessMode }),
      headers: { "Content-Type": "application/json" },
      method: "PUT"
    }).then((response) => json<{ session: Session }>(response)),
  setMode: (sessionId: string, input: { mode?: Mode; planEntry?: PlanEntry }) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "PUT"
    }).then((response) => json<{ session: Session }>(response)),
  resolvePlan: (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { accessMode?: AccessMode; comments?: string; decision: PlanDecision }) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}/resolve`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ idempotent: boolean; session: Session }>(response)),
  revisePlan: (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { markdown: string; title: string }) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "PUT"
    }).then((response) => json<{ session: Session }>(response)),
  answerQuestion: (sessionId: string, interactionId: string, answers: Record<string, string>) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(interactionId)}/answer`, {
      body: JSON.stringify({ answers }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ idempotent: boolean; session: Session }>(response)),
  resolveApproval: (approvalId: string, decision: ApprovalChoice) =>
    fetch(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      body: JSON.stringify({ decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ ok: boolean }>(response)),
  streamUrl: (sessionId: string, afterOffset: number) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/stream?afterOffset=${afterOffset}`
};

export function parseEventMessage(data: string): Event[] {
  const message = JSON.parse(data) as EventStream;
  return message.kind === "events" ? message.events : [];
}
