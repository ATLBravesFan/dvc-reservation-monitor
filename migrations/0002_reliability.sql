-- Additive reliability infrastructure. Existing snapshots and alerts remain untouched.
CREATE TABLE IF NOT EXISTS execution_leases (
  source TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_history (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_history_source_time ON execution_history(source, started_at DESC);
CREATE TABLE IF NOT EXISTS alert_outbox (
  alert_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_pending ON alert_outbox(status, next_attempt_at);
