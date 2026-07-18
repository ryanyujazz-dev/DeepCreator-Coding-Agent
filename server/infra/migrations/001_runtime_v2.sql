CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  activity_id TEXT,
  offset INTEGER NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE(session_id, offset)
);
CREATE INDEX IF NOT EXISTS events_session_offset_idx ON events(session_id, offset);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_root TEXT NOT NULL,
  search_text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  session_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  run_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_session_started_idx ON runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS context_entries (
  record_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX IF NOT EXISTS context_entries_session_idx ON context_entries(session_id, sequence);

CREATE TABLE IF NOT EXISTS metrics (
  metric_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metric_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_session_idx ON metrics(session_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL,
  project_root TEXT,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  memory_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(visibility, project_root, updated_at);

CREATE TABLE IF NOT EXISTS token_calibration (
  model TEXT PRIMARY KEY,
  factor REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  location TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta_json TEXT NOT NULL
);
