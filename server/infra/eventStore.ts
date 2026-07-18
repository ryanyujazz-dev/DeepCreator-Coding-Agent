import { Event, Session } from "../../shared/contracts/runtime";
import { Database } from "./database";
import { SessionStore } from "./sessionStore";

export class EventStore {
  constructor(
    private readonly database: Database,
    private readonly sessions: SessionStore
  ) {}

  append(event: Event, session: Session): void {
    this.database.transaction(() => {
      this.insert(event);
      const run = event.scope.runId ? session.runs.find((item) => item.runId === event.scope.runId) : undefined;
      this.sessions.save(session, run);
    });
  }

  import(events: Event[], session: Session): void {
    this.database.transaction(() => {
      for (const event of events) this.insert(event);
      for (const run of session.runs) this.sessions.save(session, run);
      if (session.runs.length === 0) this.sessions.save(session);
    });
  }

  read(sessionId: string, afterOffset = 0): Event[] {
    return (this.database.raw.prepare(`SELECT event_json FROM events
      WHERE session_id = ? AND offset > ? ORDER BY offset`).all(sessionId, afterOffset) as Array<{ event_json: string }>)
      .map((row) => JSON.parse(row.event_json) as Event);
  }

  count(sessionId: string): number {
    const row = this.database.raw.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = ?").get(sessionId) as { count: number };
    return Number(row.count);
  }

  private insert(event: Event): void {
    this.database.raw.prepare(`INSERT OR IGNORE INTO events
      (event_id, session_id, run_id, activity_id, offset, version, type, at, data_json, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.eventId,
        event.scope.sessionId,
        event.scope.runId ?? null,
        event.scope.activityId ?? null,
        event.offset,
        event.version,
        event.type,
        event.at,
        JSON.stringify(event.data),
        JSON.stringify(event)
      );
  }
}
