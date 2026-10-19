-- Keep source-specific newest-alert timing queries efficient even once the
-- durable outbox has accumulated many months of unrelated reservations.
CREATE INDEX IF NOT EXISTS idx_alert_outbox_source_status_updated
  ON alert_outbox(source,status,updated_at DESC);
