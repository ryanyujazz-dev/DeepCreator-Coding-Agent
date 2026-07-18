CREATE INDEX IF NOT EXISTS events_run_offset_idx ON events(run_id, offset) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_activity_offset_idx ON events(activity_id, offset) WHERE activity_id IS NOT NULL;
