CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, revision),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plan_revisions_session
  ON plan_revisions(session_id, updated_at);

CREATE TABLE IF NOT EXISTS questions (
  interaction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  question_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_session
  ON questions(session_id, created_at);
