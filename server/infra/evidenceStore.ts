import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "./database";

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid evidence identity.");
  return value;
}

export class EvidenceStore {
  constructor(
    private readonly database: Database,
    private readonly dataDirectory: string
  ) {}

  writeArtifact(sessionId: string, recordId: string, text: string): string {
    const directory = path.join(this.dataDirectory, "evidence", safeId(sessionId));
    mkdirSync(directory, { recursive: true });
    const evidenceId = safeId(recordId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    const filePath = path.join(directory, `${evidenceId}.txt`);
    writeFileSync(filePath, text, "utf8");
    this.record(evidenceId, sessionId, undefined, "context", filePath);
    return `evidence://${sessionId}/${evidenceId}`;
  }

  writeDebug(sessionId: string, runId: string, value: unknown): void {
    if (process.env.NODE_ENV === "production" || process.env.DEEPSEEK_CONTEXT_DEBUG !== "1") return;
    const directory = path.join(this.dataDirectory, "debug", safeId(sessionId));
    mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${safeId(runId)}.json`);
    writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    this.record(`debug_${runId}`, sessionId, runId, "debug", filePath);
  }

  private record(evidenceId: string, sessionId: string, runId: string | undefined, kind: string, location: string): void {
    this.database.raw.prepare(`INSERT OR REPLACE INTO evidence
      (evidence_id, session_id, run_id, kind, location, created_at, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(evidenceId, sessionId, runId ?? null, kind, location, new Date().toISOString(), "{}");
  }
}
