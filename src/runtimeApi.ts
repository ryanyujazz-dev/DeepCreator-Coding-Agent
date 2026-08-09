import { Event, ApprovalChoice, AccessMode, EventStream, Mode, Plan, PlanDecision, PlanEntry, WorkspaceKind } from "../shared/contracts/runtime";
import {
  decodeArchiveSessionsResponse,
  decodeChanges,
  decodeContextObserverResponse,
  decodeEventStream,
  decodeInteractionResponse,
  decodeOkResponse,
  decodeRuntimeBalance,
  decodeRuntimeConfig,
  decodeRuntimeFilePreview,
  decodeSessionResponse,
  decodeSessionsResponse,
  decodeWorkspaceResponse,
  RuntimeDecoder
} from "../shared/schemas/api";
import { browserPlatform } from "./platform/browser";

export type {
  RuntimeBalance,
  RuntimeConfig,
  RuntimeContextObserver,
  RuntimeContextTelemetry,
  RuntimeFilePreview,
  RuntimeWorkspace
} from "../shared/contracts/api";

export class RuntimeRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
  }
}

async function json<T>(response: Response, decode: RuntimeDecoder<T>): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body || `Request failed: ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.message === "string") message = record.message;
        else if (typeof record.error === "string") message = record.error;
      }
    } catch {
      // Preserve a plain-text response.
    }
    throw new RuntimeRequestError(message, response.status);
  }
  return decode(await response.json());
}

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

  config = () => this.request("/api/config", decodeRuntimeConfig);
  getBalance = () => this.request("/api/balance", decodeRuntimeBalance);
  listSessions = (query = "") => this.request(
    `/api/sessions${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`,
    decodeSessionsResponse
  );
  getSession = (sessionId: string) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, decodeSessionResponse);
  getWorkspace = (sessionId: string) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, decodeWorkspaceResponse);
  getContextObserver = (sessionId: string) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/context-observer`, decodeContextObserverResponse);
  getFile = (sessionId: string, path: string) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`, decodeRuntimeFilePreview);
  getChanges = (sessionId: string) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/changes`, decodeChanges);
  startRun = (input: { model: string; accessMode: AccessMode; mode: Mode; planEntry: PlanEntry; projectRoot?: string; prompt: string; sessionId?: string; workspaceKind?: WorkspaceKind }) => {
    const sessionId = input.sessionId ?? browserPlatform.createId("session");
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, decodeSessionResponse, { body: JSON.stringify(input), method: "POST" });
  };
  queueFollowUp = (sessionId: string, input: { model: string; accessMode: AccessMode; mode: Mode; planEntry: PlanEntry; prompt: string }) => this.request(
    `/api/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
    decodeSessionResponse,
    { body: JSON.stringify(input), method: "POST" }
  );
  removeFollowUp = (sessionId: string, followUpId: string) => this.request(
    `/api/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}`,
    decodeSessionResponse,
    { method: "DELETE" }
  );
  steerFollowUp = (sessionId: string, followUpId: string) => this.request(
    `/api/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}/steer`,
    decodeSessionResponse,
    { method: "POST" }
  );
  cancelRun = (runId: string) => this.request(`/api/runs/${encodeURIComponent(runId)}/cancel`, decodeOkResponse, { method: "POST" });
  stopCommand = (commandId: string) => this.request(`/api/commands/${encodeURIComponent(commandId)}/stop`, decodeOkResponse, { method: "POST" });
  setSessionSidebar = (sessionId: string, input: { archived?: boolean; pinned?: boolean }) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/sidebar`, decodeOkResponse, {
    body: JSON.stringify(input), method: "PUT"
  });
  archiveProjectSessions = (projectRoot: string) => this.request("/api/projects/archive-sessions", decodeArchiveSessionsResponse, {
    body: JSON.stringify({ projectRoot }), method: "POST"
  });
  setAccessMode = (sessionId: string, accessMode: AccessMode) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/access-mode`, decodeSessionResponse, {
    body: JSON.stringify({ accessMode }), method: "PUT"
  });
  setMode = (sessionId: string, input: { mode?: Mode; planEntry?: PlanEntry }) => this.request(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, decodeSessionResponse, {
    body: JSON.stringify(input), method: "PUT"
  });
  resolvePlan = (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { accessMode?: AccessMode; comments?: string; decision: PlanDecision }) =>
    this.request(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}/resolve`, decodeInteractionResponse, {
      body: JSON.stringify(input), method: "POST"
    });
  revisePlan = (sessionId: string, plan: Pick<Plan, "planId" | "revision">, input: { markdown: string; title: string }) =>
    this.request(`/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.planId)}/revisions/${plan.revision}`, decodeSessionResponse, {
      body: JSON.stringify(input), method: "PUT"
    });
  answerQuestion = (sessionId: string, interactionId: string, answers: Record<string, string>) =>
    this.request(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(interactionId)}/answer`, decodeInteractionResponse, {
      body: JSON.stringify({ answers }), method: "POST"
    });
  resolveApproval = (approvalId: string, decision: ApprovalChoice) => this.request(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, decodeOkResponse, {
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
          if (!response.ok) await json(response, (value) => value);
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

  request<T>(path: string, decode: RuntimeDecoder<T>, init: RequestInit = {}): Promise<T> {
    const hasBody = init.body !== undefined && init.body !== null;
    return fetch(this.url(path), { ...init, headers: this.headers(init.headers, hasBody) }).then((response) => json(response, decode));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export const runtimeApi = new RuntimeClient();

export function parseEventMessage(data: string): Event[] {
  const message: EventStream = decodeEventStream(JSON.parse(data));
  return message.kind === "events" ? message.events : [];
}
