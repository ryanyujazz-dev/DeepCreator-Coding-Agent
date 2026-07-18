import { Run, Session, SessionSummary } from "../../shared/contracts/runtime";
import { Database } from "./database";

function searchText(session: Session): string {
  return [
    session.title,
    session.projectRoot,
    ...session.runs.flatMap((run) => [
      run.prompt,
      run.answer,
      ...run.plan.map((item) => item.label),
      ...run.changes.files.map((file) => file.path)
    ])
  ].join("\n");
}

export class SessionStore {
  constructor(private readonly database: Database) {}

  save(session: Session, run?: Run): void {
    this.database.raw.prepare(`INSERT INTO sessions
      (session_id, title, project_root, search_text, updated_at, session_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        title = excluded.title,
        project_root = excluded.project_root,
        search_text = excluded.search_text,
        updated_at = excluded.updated_at,
        session_json = excluded.session_json`)
      .run(session.sessionId, session.title, session.projectRoot, searchText(session), session.updatedAt, JSON.stringify(session));
    if (run) {
      this.database.raw.prepare(`INSERT INTO runs (run_id, session_id, status, started_at, run_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, run_json = excluded.run_json`)
        .run(run.runId, run.sessionId, run.status, run.startedAt, JSON.stringify(run));
    }
  }

  get(sessionId: string): Session | undefined {
    const row = this.database.raw.prepare("SELECT session_json FROM sessions WHERE session_id = ?").get(sessionId) as { session_json: string } | undefined;
    return row ? JSON.parse(row.session_json) as Session : undefined;
  }

  all(): Session[] {
    return (this.database.raw.prepare("SELECT session_json FROM sessions ORDER BY updated_at DESC").all() as Array<{ session_json: string }>)
      .map((row) => JSON.parse(row.session_json) as Session);
  }

  list(query = ""): SessionSummary[] {
    const normalized = query.trim().toLowerCase();
    const rows = normalized
      ? this.database.raw.prepare("SELECT session_json FROM sessions WHERE lower(search_text) LIKE ? ORDER BY updated_at DESC").all(`%${normalized}%`)
      : this.database.raw.prepare("SELECT session_json FROM sessions ORDER BY updated_at DESC").all();
    return (rows as Array<{ session_json: string }>).map((row) => JSON.parse(row.session_json) as Session).map((session) => ({
      active: session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued"),
      createdAt: session.createdAt,
      model: session.model,
      projectRoot: session.projectRoot,
      runCount: session.runs.length,
      sessionId: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt
    }));
  }
}
