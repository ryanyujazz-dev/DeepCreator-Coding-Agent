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
      // Preserve a plain-text response.
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
  workspaceRoot: string;
};

// 账户余额查询结果(对应后端 GET /api/balance)。
// 用于在 context-meter popover 显示 DeepSeek 账户剩余额度。
export type RuntimeBalance = {
  isAvailable: boolean;
  balanceInfos: Array<{
    currency: string;
    totalBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
  }>;
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

export type RuntimeWorkspace = {
  branch?: string;
  dirtyFiles: number;
  exists: boolean;
  git: boolean;
  name: string;
  projectRoot: string;
};

export class SSEDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk.replaceAll("\r\n", "\n");
    const messages: string[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(data);
      boundary = this.buffer.indexOf("\n\n");
    }
    return messages;
  }
}

export class RuntimeClient {
  private baseUrl = "";
  private token?: string;

  configure(input: { baseUrl?: string; token?: string }): void {
    this.baseUrl = (input.baseUrl ?? "").replace(/\/$/, "");
    this.token = input.token;
  }

  config = () => this.request<RuntimeConfig>("/api/config");
  getBalance = () => this.request<RuntimeBalance>("/api/balance");
  listSessions = (query = "") => this.request<{ sessions: import("../shared/contracts/runtime").SessionSummary[] }>(
    `/api/sessions${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`
  );
  getSession = (sessionId: string) => this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  getWorkspace = (sessionId: string) => this.request<{ workspace: RuntimeWorkspace }>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`);
  getContextObserver = (sessionId: string) => this.request<{ observer: RuntimeContextObserver }>(`/api/sessions/${encodeURIComponent(sessionId)}/context-observer`);
  getFile = (sessionId: string, path: string) => this.request<RuntimeFilePreview>(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`);
  startRun = (input: { model: string; accessMode: AccessMode; mode: Mode; planEntry: PlanEntry; projectRoot?: string; prompt: string; sessionId?: string }) => {
    const sessionId = input.sessionId ?? `session_${crypto.randomUUID()}`;
    return this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, { body: JSON.stringify(input), method: "POST" });
  };
  cancelRun = (runId: string) => this.request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  stopCommand = (commandId: string) => this.request<{ ok: boolean }>(`/api/commands/${encodeURIComponent(commandId)}/stop`, { method: "POST" });
  setSessionSidebar = (sessionId: string, input: { archived?: boolean; pinned?: boolean }) => this.request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/sidebar`, {
    body: JSON.stringify(input), method: "PUT"
  });
  archiveProjectSessions = (projectRoot: string) => this.request<{ archived: number }>("/api/projects/archive-sessions", {
    body: JSON.stringify({ projectRoot }), method: "POST"
  });
  setAccessMode = (sessionId: string, accessMode: AccessMode) => this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/access-mode`, {
    body: JSON.stringify({ accessMode }), method: "PUT"
  });
  setMode = (sessionId: string, input: { mode?: Mode; planEntry?: PlanEntry }) => this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, {
    body: JSON.stringify(input), method: "PUT"
  });
  resolvePlan = (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { accessMode?: AccessMode; comments?: string; decision: PlanDecision }) =>
    this.request<{ idempotent: boolean; session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}/resolve`, {
      body: JSON.stringify(input), method: "POST"
    });
  revisePlan = (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { markdown: string; title: string }) =>
    this.request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}`, {
      body: JSON.stringify(input), method: "PUT"
    });
  answerQuestion = (sessionId: string, interactionId: string, answers: Record<string, string>) =>
    this.request<{ idempotent: boolean; session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(interactionId)}/answer`, {
      body: JSON.stringify({ answers }), method: "POST"
    });
  resolveApproval = (approvalId: string, decision: ApprovalChoice) => this.request<{ ok: boolean }>(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    body: JSON.stringify({ decision }), method: "POST"
  });

  subscribe(input: {
    afterOffset: number;
    onError: (error: unknown) => void;
    onEvents: (events: Event[]) => void;
    onOpen: () => void;
    sessionId: string;
  }): () => void {
    const controller = new AbortController();
    let offset = input.afterOffset;
    const run = async () => {
      let retryMs = 400;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(this.url(`/api/sessions/${encodeURIComponent(input.sessionId)}/stream?afterOffset=${offset}`), {
            headers: this.headers(), signal: controller.signal
          });
          if (!response.ok) await json<never>(response);
          if (!response.body) throw new Error("Runtime stream is unavailable.");
          input.onOpen();
          retryMs = 400;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const sse = new SSEDecoder();
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            for (const data of sse.push(decoder.decode(next.value, { stream: true }))) {
              const events = parseEventMessage(data);
              if (events.length === 0) continue;
              offset = Math.max(offset, events.at(-1)!.offset);
              input.onEvents(events);
            }
          }
          if (!controller.signal.aborted) throw new Error("Runtime stream closed.");
        } catch (error) {
          if (controller.signal.aborted) return;
          input.onError(error);
          await new Promise((resolve) => setTimeout(resolve, retryMs));
          retryMs = Math.min(5_000, retryMs * 2);
        }
      }
    };
    void run();
    return () => controller.abort();
  }

  private headers(init?: HeadersInit, hasBody = false): Headers {
    const headers = new Headers(init);
    if (hasBody) headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    return headers;
  }

  private request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const hasBody = init.body !== undefined && init.body !== null;
    return fetch(this.url(path), { ...init, headers: this.headers(init.headers, hasBody) }).then((response) => json<T>(response));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export const runtimeApi = new RuntimeClient();

export function parseEventMessage(data: string): Event[] {
  const message = JSON.parse(data) as EventStream;
  return message.kind === "events" ? message.events : [];
}
