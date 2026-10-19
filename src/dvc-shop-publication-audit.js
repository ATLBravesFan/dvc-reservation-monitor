import { boundedFetch } from "./bounded-fetch.js";
import { WATCHES } from "./config.js";
import { Storage } from "./storage.js";
import { withLease } from "./execution-lease.js";

const SOURCE = "dvc-shop-publication-audit";
const START_KEY = "dvc-shop-publication-audit-started";
const WORDPRESS_URL = "https://rentals.dvcshop.com/wp-json/wp/v2/reservations?per_page=100&orderby=date&order=desc&_fields=id,date_gmt,status";
const LATE_AFTER_MINUTES = 12;
const RECENT_LIMIT = 50;

// WordPress date_gmt refers to a single reservation post, unlike the generic
// booking page's 2021 template publication date. It is NOT guaranteed to be
// the exact moment the reservation became publicly bookable.
export function parsePublicationPosts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("DVC Shop publication API returned no reservation posts");
  const rows = [];
  for (const item of raw) {
    const id = String(item?.id ?? "");
    const text = String(item?.date_gmt ?? "");
    if (!/^\d{5,}$/.test(id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(text)) continue;
    const iso = text + "Z";
    if (!Number.isFinite(Date.parse(iso))) continue;
    if (item.status && item.status !== "publish") continue;
    rows.push({ id, publishedAt: new Date(iso).toISOString() });
  }
  if (rows.length < Math.min(10, raw.length)) {
    throw new Error(`DVC Shop publication API had too few valid records: ${rows.length}/${raw.length}`);
  }
  return rows;
}

// The normal DVC Shop watch, not this secondary metadata checker, is
// authoritative about when a reservation was first *observed*.
// Write only newly detected IDs or first-availability transitions. Rewriting
// all ~500 listings each five minutes would exceed free D1 write limits.
export async function recordDvcShopObservations(db, rows, previous, at = new Date()) {
  if (!previous) return { firstSeen: 0, firstAvailable: 0 }; // existing baseline
  const stamp = at.toISOString();
  let firstSeen = 0, firstAvailable = 0;
  for (const row of rows) {
    const id = String(row.id);
    const before = previous[id];
    const available = WATCHES.dvcShop.match(row);
    if (!before) {
      await db.prepare(`INSERT INTO dvc_shop_publication_audit
        (listing_id,first_seen_at,first_eligible_at,first_seen_method,created_at,updated_at)
        VALUES (?,?,?,'observed',?,?)
        ON CONFLICT(listing_id) DO UPDATE SET
          first_seen_at=COALESCE(dvc_shop_publication_audit.first_seen_at,excluded.first_seen_at),
          first_eligible_at=COALESCE(dvc_shop_publication_audit.first_eligible_at,excluded.first_eligible_at),
          first_seen_method='observed',
          updated_at=excluded.updated_at`)
        .bind(id, stamp, available ? stamp : null, stamp, stamp).run();
      firstSeen++;
    } else if (available && !WATCHES.dvcShop.match(before)) {
      // Reactivations do not imply a newly published post.
      await db.prepare(`INSERT INTO dvc_shop_publication_audit
        (listing_id,first_eligible_at,first_seen_method,created_at,updated_at)
        VALUES (?,?,'preexisting',?,?)
        ON CONFLICT(listing_id) DO UPDATE SET
          first_eligible_at=COALESCE(dvc_shop_publication_audit.first_eligible_at,excluded.first_eligible_at),
          updated_at=excluded.updated_at`)
        .bind(id, stamp, stamp, stamp).run();
      firstAvailable++;
    }
  }
  return { firstSeen, firstAvailable };
}

// Called after Brevo accepts an alert and its durable outbox claims are sent.
// This records send time, NOT when Gmail delivered or notified the device.
export async function recordDvcShopAlertSends(db, events, at = new Date()) {
  const stamp = at.toISOString();
  for (const item of events) {
    const event = item?.event || item;
    const id = String(event?.listing?.id || "");
    if (!/^\d{5,}$/.test(id)) continue;
    const isNew = event.type === "NEW";
    await db.prepare(`INSERT INTO dvc_shop_publication_audit
      (listing_id,first_alert_sent_at,last_alert_sent_at,first_seen_method,created_at,updated_at)
      VALUES (?,?,?,'unobserved',?,?)
      ON CONFLICT(listing_id) DO UPDATE SET
        first_alert_sent_at=COALESCE(dvc_shop_publication_audit.first_alert_sent_at,excluded.first_alert_sent_at),
        last_alert_sent_at=excluded.last_alert_sent_at,
        updated_at=excluded.updated_at`)
      .bind(id, isNew ? stamp : null, stamp, stamp, stamp).run();
  }
}

// This independent check cannot advance the reservation snapshot or enqueue
// any email. Its only write targets are its own audit table/health/metainfo.
export async function runDvcShopPublicationAudit(env, at = new Date()) {
  return withLease(env.DB, SOURCE, async () => {
    const store = new Storage(env.DB);
    try {
      let startedAt = await store.getMeta(START_KEY);
      if (!startedAt) {
        startedAt = at.toISOString();
        await store.putMeta(START_KEY, startedAt);
      }
      const response = await boundedFetch(WORDPRESS_URL, {
        timeoutMs: 12000,
        headers: { Accept: "application/json", "User-Agent": "DVC-Monitor-Publication-Audit/1.0" },
      });
      if (!response.ok) throw new Error(`DVC Shop publication API HTTP ${response.status}`);
      const posts = parsePublicationPosts(await response.json());
      const existingResult = await env.DB.prepare(
        "SELECT listing_id,published_at FROM dvc_shop_publication_audit WHERE listing_id IN (" +
        posts.map(() => "?").join(",") + ")"
      ).bind(...posts.map(p => p.id)).all();
      const existing = new Map((existingResult.results || []).map(r => [r.listing_id, r]));
      const snapshot = (await store.getSnapshot("dvc-shop")) || {};
      const stamp = new Date().toISOString();
      let added = 0, enriched = 0;
      for (const post of posts) {
        const old = existing.get(post.id);
        if (old?.published_at) continue;
        if (old) {
          await env.DB.prepare(`UPDATE dvc_shop_publication_audit
            SET published_at=?,updated_at=? WHERE listing_id=? AND published_at IS NULL`)
            .bind(post.publishedAt, stamp, post.id).run();
          enriched++;
        } else {
          // A listing already in the snapshot predated this audit, unless its
          // first observed timestamp was recorded separately by the live poll.
          const prior = Object.prototype.hasOwnProperty.call(snapshot, post.id);
          await env.DB.prepare(`INSERT OR IGNORE INTO dvc_shop_publication_audit
            (listing_id,published_at,first_seen_method,created_at,updated_at)
            VALUES (?,?,?,?,?)`)
            .bind(post.id, post.publishedAt, prior ? "preexisting" : "unobserved", stamp, stamp).run();
          added++;
        }
      }
      const report = await getDvcShopPublicationReport(env.DB, { limit: RECENT_LIMIT, at });
      const result = {
        postsChecked: posts.length, added, enriched,
        firstSeen: report.summary.firstSeen,
        firstNotified: report.summary.notified,
        reviewNeeded: report.summary.reviewNeeded,
        startedAt,
      };
      await store.recordHealth(SOURCE, true, result, null);
      return result;
    } catch (error) {
      await store.recordHealth(SOURCE, false, null, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}

export function evaluateDvcShopPublication(row, { now = new Date(), enabledAt, currentlyAvailable = false, inSnapshot = false } = {}) {
  const publishedMs = Date.parse(row.published_at || "");
  const firstSeenMs = Date.parse(row.first_seen_at || "");
  const firstEligibleMs = Date.parse(row.first_eligible_at || "");
  const sentMs = Date.parse(row.first_alert_sent_at || "");
  const enabledMs = Date.parse(enabledAt || "");
  const newDuringAudit = Number.isFinite(publishedMs) && Number.isFinite(enabledMs) && publishedMs >= enabledMs;
  const ageMinutes = Number.isFinite(publishedMs) ? (now.getTime() - publishedMs) / 60000 : null;
  const detectionMinutes = Number.isFinite(publishedMs) && Number.isFinite(firstSeenMs)
    ? (firstSeenMs - publishedMs) / 60000 : null;
  const notificationMinutes = Number.isFinite(publishedMs) && Number.isFinite(sentMs)
    ? (sentMs - publishedMs) / 60000 : null;
  const overdue = newDuringAudit && ageMinutes >= LATE_AFTER_MINUTES;
  let state = "historical";
  if (newDuringAudit) {
    if (Number.isFinite(sentMs)) state = "notified";
    else if (Number.isFinite(firstEligibleMs) && currentlyAvailable && overdue) state = "unnotified";
    else if (!Number.isFinite(firstSeenMs) && !inSnapshot && overdue) state = "published-not-detected";
    else if (!Number.isFinite(firstSeenMs) && inSnapshot) state = "seen-without-first-seen-time";
    else state = "monitoring";
  }
  return { state, detectionMinutes, notificationMinutes };
}

export async function getDvcShopPublicationReport(db, { limit = RECENT_LIMIT, at = new Date() } = {}) {
  const store = new Storage(db);
  const enabledAt = await store.getMeta(START_KEY);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || RECENT_LIMIT)));
  if (!enabledAt) return { enabledAt: null, checkedAt: at.toISOString(), summary: { firstSeen: 0, notified: 0, reviewNeeded: 0 }, rows: [], note: "Audit has not started; historical listings cannot be timed retroactively." };
  const result = await db.prepare(`SELECT listing_id,published_at,first_seen_at,first_eligible_at,first_alert_sent_at,last_alert_sent_at,first_seen_method
    FROM dvc_shop_publication_audit WHERE published_at >= ? OR first_seen_at >= ? OR first_eligible_at >= ?
    ORDER BY COALESCE(published_at,first_seen_at,first_eligible_at) DESC LIMIT ?`)
    .bind(enabledAt, enabledAt, enabledAt, safeLimit).all();
  const snapshot = (await store.getSnapshot("dvc-shop")) || {};
  const rows = (result.results || []).map(raw => {
    const listing = snapshot[raw.listing_id];
    const { state, detectionMinutes, notificationMinutes } = evaluateDvcShopPublication(raw, {
      now: at, enabledAt, inSnapshot: Boolean(listing), currentlyAvailable: Boolean(listing && WATCHES.dvcShop.match(listing)),
    });
    return {
      id: raw.listing_id, resort: listing?.resort || null,
      publishedAt: raw.published_at, firstSeenAt: raw.first_seen_at,
      firstEligibleAt: raw.first_eligible_at, firstAlertSentAt: raw.first_alert_sent_at,
      lastAlertSentAt: raw.last_alert_sent_at,
      firstSeenMethod: raw.first_seen_method,
      detectionMinutes: Number.isFinite(detectionMinutes) ? Number(detectionMinutes.toFixed(2)) : null,
      notificationMinutes: Number.isFinite(notificationMinutes) ? Number(notificationMinutes.toFixed(2)) : null,
      state,
    };
  });
  const duration = rows.filter(r => r.state === "notified" && r.notificationMinutes !== null)
    .map(r => r.notificationMinutes).sort((a, b) => a - b);
  const median = duration.length ? duration[Math.floor(duration.length / 2)] : null;
  return {
    enabledAt, checkedAt: at.toISOString(),
    note: "WordPress post date is not guaranteed first public availability. Send time means Brevo accepted the message, not inbox delivery. Only new posts published after audit activation can be classified as missed. Older listings and earlier deliveries cannot be reconstructed.",
    summary: {
      sampled: rows.length,
      firstSeen: rows.filter(r => r.firstSeenAt).length,
      notified: rows.filter(r => r.state === "notified").length,
      reviewNeeded: rows.filter(r => ["unnotified", "published-not-detected", "seen-without-first-seen-time"].includes(r.state)).length,
      medianNotificationMinutes: median,
      withinSixMinutes: duration.filter(n => n <= 6).length,
    },
    rows,
  };
}
