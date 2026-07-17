import { AgentSignal, ApprovalDecision, PermissionProfileKey, SignalStreamMessage, WorkspaceSessionView } from "../shared/runtimeTypes";

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
  defaultModel: string;
  hasApiKey: boolean;
  signalContract: string;
};

export type RuntimeFilePreview = {
  content: string;
  path: string;
  projectRoot: string;
  truncated: boolean;
};

export const runtimeClient = {
  config: () => fetch("/api/config").then((response) => json<RuntimeConfig>(response)),
  listSessions: (query = "") =>
    fetch(`/api/sessions${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`).then((response) =>
      json<{ sessions: import("../shared/runtimeTypes").SessionListEntry[] }>(response)
    ),
  getSession: (sessionKey: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionKey)}`).then((response) =>
      json<{ session: WorkspaceSessionView }>(response)
    ),
  getFile: (sessionKey: string, path: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/files?path=${encodeURIComponent(path)}`).then((response) =>
      json<RuntimeFilePreview>(response)
    ),
  startCycle: (input: { model: string; permissionProfile: PermissionProfileKey; prompt: string; sessionKey?: string }) =>
    fetch("/api/cycles", {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ session: WorkspaceSessionView }>(response)),
  cancelCycle: (cycleKey: string) =>
    fetch(`/api/cycles/${encodeURIComponent(cycleKey)}/cancel`, { method: "POST" }).then((response) =>
      json<{ ok: boolean }>(response)
    ),
  setPermissionProfile: (sessionKey: string, permissionProfile: PermissionProfileKey) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/permission-profile`, {
      body: JSON.stringify({ permissionProfile }),
      headers: { "Content-Type": "application/json" },
      method: "PUT"
    }).then((response) => json<{ session: WorkspaceSessionView }>(response)),
  resolveApproval: (approvalKey: string, decision: ApprovalDecision) =>
    fetch(`/api/approvals/${encodeURIComponent(approvalKey)}/resolve`, {
      body: JSON.stringify({ decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    }).then((response) => json<{ ok: boolean }>(response)),
  streamUrl: (sessionKey: string, afterOffset: number) =>
    `/api/sessions/${encodeURIComponent(sessionKey)}/stream?afterOffset=${afterOffset}`
};

export function parseSignalMessage(data: string): AgentSignal[] {
  const message = JSON.parse(data) as SignalStreamMessage;
  return message.kind === "signals" ? message.signals : [];
}
