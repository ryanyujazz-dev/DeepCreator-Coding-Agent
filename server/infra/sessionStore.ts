import { Run, Session, SessionSummary } from "../../shared/contracts/runtime";
import { decodeStoredSession } from "../../shared/legacy/decoder";
import { Database } from "./database";

function searchText(session: Session): string {
  return [
    session.title,
    session.projectRoot,
    ...session.runs.flatMap((run) => [
      run.prompt,
      run.answer,
      ...run.tasks.map((item) => item.label),
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
    for (const plan of session.plans) {
      this.database.raw.prepare(`INSERT INTO plan_revisions
        (plan_id, revision, session_id, run_id, status, updated_at, plan_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id, revision) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          plan_json = excluded.plan_json`)
        .run(plan.planId, plan.revision, plan.sessionId, plan.runId, plan.status, plan.updatedAt, JSON.stringify(plan));
    }
    for (const question of session.questions) {
      this.database.raw.prepare(`INSERT INTO questions
        (interaction_id, session_id, run_id, status, created_at, question_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(interaction_id) DO UPDATE SET
          status = excluded.status,
          question_json = excluded.question_json`)
        .run(question.interactionId, question.sessionId, question.runId, question.status, question.createdAt, JSON.stringify(question));
    }
  }

  get(sessionId: string): Session | undefined {
    const row = this.database.raw.prepare("SELECT session_json FROM sessions WHERE session_id = ?").get(sessionId) as { session_json: string } | undefined;
    return row ? decodeStoredSession(JSON.parse(row.session_json)) : undefined;
  }

  all(): Session[] {
    return (this.database.raw.prepare("SELECT session_json FROM sessions ORDER BY updated_at DESC").all() as Array<{ session_json: string }>)
      .map((row) => decodeStoredSession(JSON.parse(row.session_json)));
  }

  list(query = ""): SessionSummary[] {
    const normalized = query.trim().toLowerCase();
    const rows = normalized
      ? this.database.raw.prepare(`SELECT sessions.session_json, sidebar.pinned_at
          FROM sessions
          LEFT JOIN session_sidebar_state sidebar ON sidebar.session_id = sessions.session_id
          WHERE sidebar.archived_at IS NULL AND lower(sessions.search_text) LIKE ?
          ORDER BY (sidebar.pinned_at IS NOT NULL) DESC, sidebar.pinned_at DESC, sessions.updated_at DESC`).all(`%${normalized}%`)
      : this.database.raw.prepare(`SELECT sessions.session_json, sidebar.pinned_at
          FROM sessions
          LEFT JOIN session_sidebar_state sidebar ON sidebar.session_id = sessions.session_id
          WHERE sidebar.archived_at IS NULL
          ORDER BY (sidebar.pinned_at IS NOT NULL) DESC, sidebar.pinned_at DESC, sessions.updated_at DESC`).all();
    return (rows as Array<{ pinned_at?: string; session_json: string }>).map((row) => ({ row, session: decodeStoredSession(JSON.parse(row.session_json)) })).map(({ row, session }) => ({
      active: session.runs.some((run) => run.status === "running" || run.status === "waiting" || run.status === "queued"),
      createdAt: session.createdAt,
      model: session.model,
      pinned: Boolean(row.pinned_at),
      projectRoot: session.projectRoot,
      runCount: session.runs.length,
      sessionId: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt
    }));
  }

  archiveProject(projectRoot: string): number {
    const at = new Date().toISOString();
    const result = this.database.raw.prepare(`INSERT INTO session_sidebar_state (session_id, pinned_at, archived_at)
      SELECT session_id, NULL, ? FROM sessions WHERE project_root = ?
      ON CONFLICT(session_id) DO UPDATE SET pinned_at = NULL, archived_at = excluded.archived_at`).run(at, projectRoot);
    return Number(result.changes);
  }

  updateSidebarState(sessionId: string, input: { archived?: boolean; pinned?: boolean }): boolean {
    const session = this.database.raw.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId);
    if (!session) return false;
    const current = this.database.raw.prepare("SELECT pinned_at, archived_at FROM session_sidebar_state WHERE session_id = ?").get(sessionId) as { archived_at?: string; pinned_at?: string } | undefined;
    const at = new Date().toISOString();
    const archivedAt = input.archived === undefined ? current?.archived_at ?? null : input.archived ? at : null;
    const pinnedAt = archivedAt ? null : input.pinned === undefined ? current?.pinned_at ?? null : input.pinned ? at : null;
    if (!archivedAt && !pinnedAt) {
      this.database.raw.prepare("DELETE FROM session_sidebar_state WHERE session_id = ?").run(sessionId);
      return true;
    }
    this.database.raw.prepare(`INSERT INTO session_sidebar_state (session_id, pinned_at, archived_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET pinned_at = excluded.pinned_at, archived_at = excluded.archived_at`)
      .run(sessionId, pinnedAt, archivedAt);
    return true;
  }
}
