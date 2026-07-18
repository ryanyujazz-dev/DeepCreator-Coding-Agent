import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export class Database {
  readonly raw: DatabaseSync;

  constructor(filePath: string) {
    this.raw = new DatabaseSync(filePath);
    this.raw.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(work: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const directory = fileURLToPath(new URL("./migrations", import.meta.url));
    const files = readdirSync(directory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    for (const name of files) {
      const version = Number(name.slice(0, name.indexOf("_")));
      const applied = this.raw.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
      if (applied) continue;
      const sql = readFileSync(path.join(directory, name), "utf8");
      this.transaction(() => {
        this.raw.exec(sql);
        this.raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(version, name, new Date().toISOString());
      });
    }
    this.importLegacyTables();
  }

  private importLegacyTables(): void {
    const tables = new Set((this.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    if (tables.has("context_records")) {
      this.raw.exec(`INSERT OR IGNORE INTO context_entries
        (record_id, session_id, run_id, sequence, created_at, entry_json)
        SELECT record_key, session_key, cycle_key, sequence, created_at, record_json FROM context_records`);
    }
    if (tables.has("context_telemetry")) {
      this.raw.exec(`INSERT OR IGNORE INTO metrics
        (metric_id, session_id, run_id, created_at, metric_json)
        SELECT telemetry_key, session_key, cycle_key, created_at, telemetry_json FROM context_telemetry`);
    }
    if (tables.has("memory_facts")) {
      this.raw.exec(`INSERT OR IGNORE INTO memories
        (memory_id, visibility, project_root, category, updated_at, memory_json)
        SELECT memory_id, visibility, project_root, category, updated_at, fact_json FROM memory_facts`);
    }
  }
}
