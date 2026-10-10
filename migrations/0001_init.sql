CREATE TABLE IF NOT EXISTS snapshots (
  source TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_expires_at ON alerts(expires_at);

CREATE TABLE IF NOT EXISTS health (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  day TEXT PRIMARY KEY,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
