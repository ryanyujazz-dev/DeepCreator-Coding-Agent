export const RUNTIME_WORKER_CONTROL_PREFIX = "__DEEPCREATOR_RUNTIME_CONTROL__";
export const RUNTIME_WORKER_NODE_BOOTSTRAP = [
  'const sqlite = require("node:sqlite")',
  'if (typeof sqlite.DatabaseSync !== "function") throw new Error(`node:sqlite DatabaseSync is unavailable in Node ${process.versions.node}`)',
  "globalThis.__DEEPCREATOR_DATABASE_SYNC__ = sqlite.DatabaseSync",
  "require(process.argv[1])"
].join(";");

export type RuntimeWorkerControlMessage =
  | { type: "shutdown" }
  | { error?: string; port?: number; type: "ready" | "stopped" | "failed" };

export function encodeRuntimeWorkerControl(message: RuntimeWorkerControlMessage): string {
  return `${RUNTIME_WORKER_CONTROL_PREFIX}${JSON.stringify(message)}\n`;
}

export function runtimeWorkerControlFromLine(line: string): RuntimeWorkerControlMessage | undefined {
  if (!line.startsWith(RUNTIME_WORKER_CONTROL_PREFIX)) return undefined;
  try {
    const value = JSON.parse(line.slice(RUNTIME_WORKER_CONTROL_PREFIX.length)) as unknown;
    if (!value || typeof value !== "object" || !("type" in value)) return undefined;
    const type = (value as { type?: unknown }).type;
    if (type === "shutdown") return { type };
    if (type !== "ready" && type !== "stopped" && type !== "failed") return undefined;
    const message = value as { error?: unknown; port?: unknown; type: "ready" | "stopped" | "failed" };
    const normalized: RuntimeWorkerControlMessage = { type: message.type };
    if (typeof message.error === "string") normalized.error = message.error;
    if (typeof message.port === "number") normalized.port = message.port;
    return normalized;
  } catch {
    return undefined;
  }
}
