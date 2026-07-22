CREATE TABLE IF NOT EXISTS session_sidebar_state (
  session_id TEXT PRIMARY KEY,
  pinned_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_sidebar_pinned_idx ON session_sidebar_state(pinned_at DESC);
CREATE INDEX IF NOT EXISTS session_sidebar_archived_idx ON session_sidebar_state(archived_at);
