CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kv_state_expires_at ON kv_state(expires_at);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_count INTEGER
);

CREATE TABLE IF NOT EXISTS email_usage (
  day TEXT PRIMARY KEY,
  sent_count INTEGER NOT NULL DEFAULT 0,
  warning_sent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
