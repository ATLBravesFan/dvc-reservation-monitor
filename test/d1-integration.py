"""Validate real SQLite/D1-compatible migrations and atomic outbox SQL."""
import sqlite3
from pathlib import Path

db=sqlite3.connect(":memory:")
migrations=sorted(Path("migrations").glob("*.sql"))
for migration in migrations:
    db.executescript(migration.read_text())
# Ensure migrations are idempotent and do not wipe existing state.
db.execute("INSERT INTO snapshots VALUES ('existing','{}','2026-10-11')")
for migration in migrations:
    db.executescript(migration.read_text())
assert db.execute("SELECT payload FROM snapshots WHERE source='existing'").fetchone()[0]=="{}"

# The hot lease-reconciliation UPDATE must use the composite index rather than
# scanning every historical execution for a source on each one-minute check.
plan=db.execute("""EXPLAIN QUERY PLAN
 UPDATE execution_history SET finished_at=?, outcome='interrupted'
 WHERE source=? AND outcome='running' AND started_at < ?""",
 ("2026-10-13T12:00:00Z","dvc-shop","2026-10-13T11:58:30Z")).fetchall()
plan_text=" ".join(str(row) for row in plan)
assert "idx_execution_history_source_outcome_started" in plan_text, plan_text

insert="""INSERT OR IGNORE INTO alert_outbox
 (alert_key,source,listing_id,payload,status,attempts,created_at,updated_at,title,show_matches,priority)
 VALUES(?,?,?,?,'pending',0,?,?,?,?,?)"""
values=("k1","dvc-shop","r1",'{"type":"NEW"}',"2026-10-11","2026-10-11","Title",1,1)
db.execute(insert,values)
db.execute(insert,values)
assert db.execute("SELECT COUNT(*) FROM alert_outbox").fetchone()[0]==1
claim="""UPDATE alert_outbox SET status='sending',lease_until=?,updated_at=?,attempts=attempts+1
 WHERE alert_key=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)"""
assert db.execute(claim,("2026-10-11T21:01:30Z","2026-10-11T21:00:00Z","k1","2026-10-11T21:00:00Z")).rowcount==1
assert db.execute(claim,("2026-10-11T21:01:30Z","2026-10-11T21:00:00Z","k1","2026-10-11T21:00:00Z")).rowcount==0
db.execute("""UPDATE alert_outbox SET status='sent',provider_message_id=?,lease_until=NULL,updated_at=?
 WHERE alert_key=? AND status='sending'""",("msg1","2026-10-11","k1"))
assert db.execute(claim,("2026-10-11T21:01:30Z","2026-10-11T21:00:00Z","k1","2026-10-11T21:00:00Z")).rowcount==0
db.execute(insert,("k2","davids","r2","{}","2026-10-11","2026-10-11","Title",1,0))
db.execute(claim,("2026-10-11T21:01:30Z","2026-10-11T21:00:00Z","k2","2026-10-11T21:00:00Z"))
db.execute("""UPDATE alert_outbox SET status='uncertain',last_error='Delivery lease expired; provider acceptance unknown',
 lease_until=NULL,updated_at=? WHERE status='sending' AND lease_until<=?""",("2026-10-11T21:02:00Z","2026-10-11T21:02:00Z"))
assert db.execute("SELECT status FROM alert_outbox WHERE alert_key='k2'").fetchone()[0]=="uncertain"
assert db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]==1
print("Real SQLite migration, D1 index and outbox SQL integration tests passed")
