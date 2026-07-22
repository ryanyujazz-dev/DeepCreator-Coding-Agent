import { ContextEntry, ContextInput } from "../../shared/contracts/context";
import { decodeLegacyContextEntry } from "../../shared/legacy/context";
import { Database } from "./database";
import { createContextEntry } from "./contextEntry";

export class ContextStore {
  constructor(private readonly database: Database) {}

  append(input: ContextInput): ContextEntry {
    const row = this.database.raw
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM context_entries WHERE session_id = ?")
      .get(input.sessionId) as { sequence: number };
    const entry = createContextEntry(input, Number(row.sequence) + 1);
    this.database.raw.prepare(`INSERT INTO context_entries
      (record_id, session_id, run_id, sequence, created_at, entry_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(entry.recordId, entry.sessionId, entry.runId ?? null, entry.sequence, entry.createdAt, JSON.stringify(entry));
    return structuredClone(entry);
  }

  read(sessionId: string): ContextEntry[] {
    return (this.database.raw.prepare(`SELECT entry_json FROM context_entries
      WHERE session_id = ? ORDER BY sequence`).all(sessionId) as Array<{ entry_json: string }>)
      .map((row) => decodeLegacyContextEntry(JSON.parse(row.entry_json)));
  }

  runIds(sessionId: string): Set<string> {
    return new Set((this.database.raw.prepare(`SELECT DISTINCT run_id FROM context_entries
      WHERE session_id = ? AND run_id IS NOT NULL`).all(sessionId) as Array<{ run_id: string }>).map((row) => row.run_id));
  }
}
