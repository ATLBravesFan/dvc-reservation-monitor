-- Reduce D1 rows_read for the per-source lease reconciliation query.
-- acquireLease() filters execution_history by source, outcome and started_at on
-- every source execution, so the previous (source, started_at) index could still
-- scan a large number of completed rows as history accumulated.
CREATE INDEX IF NOT EXISTS idx_execution_history_source_outcome_started
  ON execution_history(source, outcome, started_at);

-- Keep time-based history maintenance cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_execution_history_started_at
  ON execution_history(started_at);

-- One-time housekeeping for any history older than the useful diagnostic window.
-- Current diagnostics only inspect recent executions, so old rows are not needed.
DELETE FROM execution_history
WHERE started_at < datetime('now', '-14 days');
