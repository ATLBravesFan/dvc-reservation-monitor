-- Read-only publication timing reconciliation. Does not alter notification snapshots.
CREATE TABLE IF NOT EXISTS dvc_shop_publication_audit (
  listing_id TEXT PRIMARY KEY,
  published_at TEXT,
  first_seen_at TEXT,
  first_eligible_at TEXT,
  first_alert_sent_at TEXT,
  last_alert_sent_at TEXT,
  first_seen_method TEXT NOT NULL DEFAULT 'unobserved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dvc_shop_pub_date ON dvc_shop_publication_audit(published_at);
CREATE INDEX IF NOT EXISTS idx_dvc_shop_pub_first_seen ON dvc_shop_publication_audit(first_seen_at);
