export class Storage {
  constructor(db) {
    if (!db) throw new Error("D1 binding DB is missing");
    this.db = db;
  }

  async getSnapshot(source) {
    const row = await this.db.prepare("SELECT payload FROM snapshots WHERE source = ?").bind(source).first();
    if (!row?.payload) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  async putSnapshot(source, payload) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO snapshots (source, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).bind(source, JSON.stringify(payload), now).run();
  }

  async claimAlert(alertKey, source, listingId, fp) {
    const now = new Date();
    const nowIso = now.toISOString();
    const pendingExpiry = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    await this.db.prepare(`DELETE FROM alerts WHERE alert_key = ? AND status = 'pending' AND expires_at <= ?`)
      .bind(alertKey, nowIso).run();

    const result = await this.db.prepare(`
      INSERT OR IGNORE INTO alerts
        (alert_key, source, listing_id, fingerprint, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).bind(alertKey, source, listingId, fp, nowIso, pendingExpiry).run();

    return Number(result?.meta?.changes || 0) > 0;
  }

  async markAlertSent(alertKey) {
    const now = new Date();
    const expiry = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.prepare(`
      UPDATE alerts SET status='sent', sent_at=?, expires_at=? WHERE alert_key=?
    `).bind(now.toISOString(), expiry, alertKey).run();
  }

  async releaseAlert(alertKey) {
    await this.db.prepare("DELETE FROM alerts WHERE alert_key = ? AND status = 'pending'")
      .bind(alertKey).run();
  }

  async cleanupExpiredAlerts() {
    await this.db.prepare("DELETE FROM alerts WHERE expires_at <= ?")
      .bind(new Date().toISOString()).run();
  }

  async getEmailCount(day = utcDay()) {
    const row = await this.db.prepare("SELECT emails_sent FROM counters WHERE day = ?").bind(day).first();
    return Number(row?.emails_sent || 0);
  }

  async incrementEmailCount(day = utcDay()) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO counters (day, emails_sent, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(day) DO UPDATE SET emails_sent = emails_sent + 1, updated_at = excluded.updated_at
    `).bind(day, now).run();
    return this.getEmailCount(day);
  }

  async getMeta(key) {
    const row = await this.db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
    if (!row?.value) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  async putMeta(key, value) {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).bind(key, JSON.stringify(value), now).run();
  }

  async recordWatchEvents(watchKeys, events) {
    const now = new Date().toISOString();
    const keys = [...new Set(watchKeys)];
    for (const key of keys) {
      const metaKey = `watch-events:${key}`;
      const previous = (await this.getMeta(metaKey)) || {};
      const added = events.filter(event => event.type === "NEW").length;
      const changed = events.length - added;
      await this.putMeta(metaKey, {
        lastAddedAt: added ? now : (previous.lastAddedAt || null),
        lastChangedAt: changed ? now : (previous.lastChangedAt || null),
        lastActivityAt: now,
        lastActivityType: added && changed ? "new and changed" : added ? "new" : "changed",
        lastActivityCount: events.length,
      });
    }
  }

  async recordHealth(source, ok, details = null, error = null) {
    const now = new Date().toISOString();
    const existing = await this.db.prepare("SELECT consecutive_failures, last_success_at FROM health WHERE source = ?")
      .bind(source).first();
    const previousFailures = Number(existing?.consecutive_failures || 0);
    const failures = ok ? 0 : previousFailures + 1;
    const lastSuccess = ok ? now : (existing?.last_success_at || null);

    await this.db.prepare(`
      INSERT INTO health
        (source, ok, last_checked_at, last_success_at, consecutive_failures, last_error, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        ok=excluded.ok,
        last_checked_at=excluded.last_checked_at,
        last_success_at=excluded.last_success_at,
        consecutive_failures=excluded.consecutive_failures,
        last_error=excluded.last_error,
        details=excluded.details
    `).bind(
      source,
      ok ? 1 : 0,
      now,
      lastSuccess,
      failures,
      error ? String(error).slice(0, 1000) : null,
      details == null ? null : JSON.stringify(details),
    ).run();

    return { previousFailures, consecutiveFailures: failures, lastSuccessAt: lastSuccess };
  }

  async allHealth() {
    const result = await this.db.prepare(`
      SELECT source, ok, last_checked_at, last_success_at, consecutive_failures, last_error, details
      FROM health ORDER BY source
    `).all();
    return (result?.results || []).map(row => ({
      source: row.source,
      ok: Boolean(row.ok),
      lastCheckedAt: row.last_checked_at,
      lastSuccessAt: row.last_success_at,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      lastError: row.last_error || null,
      details: parseJson(row.details),
    }));
  }
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}
