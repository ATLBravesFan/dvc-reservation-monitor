-- Efficient newest-first timing history reads from existing alert ledgers.
-- No table copies, no additional reservation polling, and no email writes.
CREATE INDEX IF NOT EXISTS idx_alert_outbox_status_updated
  ON alert_outbox(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_source_status_sent
  ON alerts(source, status, sent_at DESC);
