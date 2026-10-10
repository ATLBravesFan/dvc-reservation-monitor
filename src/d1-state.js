export function createD1State(db) {
  if (!db) throw new Error("D1 binding DB is not configured");

  return {
    async get(key) {
      const row = await db.prepare(
        "SELECT value, expires_at FROM kv_state WHERE key = ?1 LIMIT 1",
      ).bind(key).first();
      if (!row) return null;
      if (row.expires_at && Number(row.expires_at) <= Date.now()) return null;
      return row.value;
    },

    async put(key, value, options = {}) {
      const now = new Date().toISOString();
      const expiresAt = options?.expirationTtl
        ? Date.now() + Number(options.expirationTtl) * 1000
        : null;
      await db.prepare(`
        INSERT INTO kv_state (key, value, updated_at, expires_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `).bind(key, String(value), now, expiresAt).run();
    },

    async delete(key) {
      await db.prepare("DELETE FROM kv_state WHERE key = ?1").bind(key).run();
    },
  };
}

export async function recordHealth(db, source, ok, count = null, error = null) {
  const now = new Date().toISOString();
  if (ok) {
    await db.prepare(`
      INSERT INTO source_health (
        source, last_attempt_at, last_success_at, last_failure_at,
        consecutive_failures, last_error, last_count
      ) VALUES (?1, ?2, ?2, NULL, 0, NULL, ?3)
      ON CONFLICT(source) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        consecutive_failures = 0,
        last_error = NULL,
        last_count = excluded.last_count
    `).bind(source, now, Number.isFinite(count) ? count : null).run();
    return;
  }

  await db.prepare(`
    INSERT INTO source_health (
      source, last_attempt_at, last_success_at, last_failure_at,
      consecutive_failures, last_error, last_count
    ) VALUES (?1, ?2, NULL, ?2, 1, ?3, ?4)
    ON CONFLICT(source) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_failure_at = excluded.last_failure_at,
      consecutive_failures = source_health.consecutive_failures + 1,
      last_error = excluded.last_error,
      last_count = COALESCE(excluded.last_count, source_health.last_count)
  `).bind(
    source,
    now,
    String(error || "Unknown error").slice(0, 500),
    Number.isFinite(count) ? count : null,
  ).run();
}

export async function getHealth(db) {
  const result = await db.prepare(`
    SELECT source, last_attempt_at, last_success_at, last_failure_at,
      consecutive_failures, last_error, last_count
    FROM source_health
    ORDER BY source
  `).all();
  return result.results || [];
}

export async function getEmailUsage(db, day = utcDay()) {
  const row = await db.prepare(
    "SELECT day, sent_count, warning_sent, updated_at FROM email_usage WHERE day = ?1 LIMIT 1",
  ).bind(day).first();
  return row || { day, sent_count: 0, warning_sent: 0, updated_at: null };
}

export async function incrementEmailUsage(db, day = utcDay()) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO email_usage (day, sent_count, warning_sent, updated_at)
    VALUES (?1, 1, 0, ?2)
    ON CONFLICT(day) DO UPDATE SET
      sent_count = email_usage.sent_count + 1,
      updated_at = excluded.updated_at
  `).bind(day, now).run();
  return getEmailUsage(db, day);
}

export async function markEmailWarningSent(db, day = utcDay()) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO email_usage (day, sent_count, warning_sent, updated_at)
    VALUES (?1, 0, 1, ?2)
    ON CONFLICT(day) DO UPDATE SET
      warning_sent = 1,
      updated_at = excluded.updated_at
  `).bind(day, now).run();
}

export async function cleanupExpiredState(db) {
  await db.prepare(
    "DELETE FROM kv_state WHERE expires_at IS NOT NULL AND expires_at <= ?1",
  ).bind(Date.now()).run();
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
