ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN parent_run_id TEXT;
ALTER TABLE sessions ADD COLUMN origin_delegation_id TEXT;

CREATE INDEX IF NOT EXISTS sessions_parent_idx
  ON sessions(parent_session_id, parent_run_id);
CREATE INDEX IF NOT EXISTS sessions_origin_delegation_idx
  ON sessions(origin_delegation_id);
