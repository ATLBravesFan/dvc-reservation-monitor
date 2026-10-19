// Read-only timing report from existing durable alert ledgers. No additional
// website polling or notification emails. Outbox created_at is the moment a
// *qualifying event* entered the queue, not the site's publication timestamp.
const SOURCES = Object.freeze([
  { key: "dvc-rental-store", name: "DVC Rental Store", publication: "unavailable" },
  { key: "davids", name: "David's Vacation Rentals", publication: "unavailable" },
  { key: "dvc-rental", name: "DVC-Rental", publication: "unavailable" },
  { key: "dvc-shop", name: "DVC Shop", publication: "wordpress-post-date" },
  { key: "dvcreservations-rare-finds", name: "DVCReservations Rare Finds", publication: "unavailable" },
]);
const MAX_ROWS = 60;
const SLOW_MINUTES = 12;

export function normalizeTimingRecord(raw, shopMetadata = null) {
  const source = SOURCES.find(x => x.key === raw.source);
  if (!source) return null;
  const detectedAt = validIso(raw.detectedAt);
  const sentAt = validIso(raw.sentAt);
  const publicationAt = raw.source === "dvc-shop" ? validIso(shopMetadata?.published_at) : null;
  const firstSeenAt = raw.source === "dvc-shop" ? validIso(shopMetadata?.first_seen_at) : null;
  // WordPress publication time only applies to a NEW reservation, not a
  // repricing of an old post. Don't label the latter as a very slow alert.
  const postToSend = raw.eventType === "NEW"
    ? durationMinutes(publicationAt, sentAt) : null;
  const detectionToSend = durationMinutes(detectedAt, sentAt);
  return {
    source: raw.source,
    sourceName: source.name,
    listingId: String(raw.listingId),
    eventType: raw.eventType,
    eventDetectedAt: detectedAt,
    firstSeenAt,
    publicationAt,
    publishedTimeSource: source.publication,
    sentAt,
    detectionToSendMinutes: detectionToSend,
    publicationToSendMinutes: postToSend,
    delayed: detectionToSend !== null && detectionToSend > SLOW_MINUTES,
    sentTimeMeaning: "Provider accepted email; not inbox arrival",
    status: raw.status,
  };
}
export function durationMinutes(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 60000 * 100) / 100;
}
function validIso(raw) {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function jsonEvent(payload) {
  try {
    const event = JSON.parse(payload);
    return event?.type === "NEW" || event?.type === "PRICE CHANGE" ? event.type : "OTHER CHANGE";
  } catch {
    return "UNKNOWN";
  }
}
function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a,b) => a-b);
  return sorted[Math.floor(sorted.length/2)];
}

export async function getAllWatchTimingReport(db, { source = null, limit = 30 } = {}) {
  if (source && !SOURCES.some(x => x.key === source)) throw new Error("Unknown timing audit source");
  const capped = Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(limit) || 30)));
  // Sample each website independently. A busy DVC-Rental feed must not
  // crowd David's, Rental Store or Rare Finds out of the audit view.
  const selected = SOURCES.filter(x => !source || x.key === source);
  const batches = await Promise.all(selected.map(async site => {
    if (site.key === "dvcreservations-rare-finds") {
      // Rare Finds uses the legacy immediate-send ledger.
      const rare = await db.prepare(`SELECT source,listing_id,created_at,sent_at,status
        FROM alerts WHERE source='dvcreservations-rare-finds' AND status='sent'
        ORDER BY sent_at DESC LIMIT ?`).bind(capped).all();
      return (rare.results || []).map(r => ({
        source:r.source,listingId:r.listing_id,eventType:"NEW/CHANGE (not recorded)",
        detectedAt:r.created_at,sentAt:r.sent_at,status:r.status,
      }));
    }
    const records = await db.prepare(`SELECT alert_key,source,listing_id,payload,created_at,updated_at,status
      FROM alert_outbox WHERE status='sent' AND source = ?
      ORDER BY updated_at DESC LIMIT ?`)
      .bind(site.key, capped).all();
    return (records.results || []).map(r => ({
      source:r.source,listingId:r.listing_id,eventType:jsonEvent(r.payload),
      detectedAt:r.created_at,sentAt:r.updated_at,status:r.status,
    }));
  }));
  const normalized = batches.flat();
  normalized.sort((a,b)=>String(b.sentAt||"").localeCompare(String(a.sentAt||"")));
  const recent = normalized;
  const ids=[...new Set(recent.filter(r=>r.source==="dvc-shop").map(r=>String(r.listingId)))];
  let shop=new Map();
  if (ids.length) {
    const response=await db.prepare(`SELECT listing_id,published_at,first_seen_at
      FROM dvc_shop_publication_audit WHERE listing_id IN (${ids.map(()=>"?").join(",")})`)
      .bind(...ids).all();
    shop=new Map((response.results||[]).map(r=>[String(r.listing_id),r]));
  }
  const rows=recent.map(r=>normalizeTimingRecord(r,shop.get(String(r.listingId)))).filter(Boolean);
  const bySource=SOURCES.filter(x=>!source||source===x.key).map(s=>{
    const sample=rows.filter(r=>r.source===s.key);
    const delays=sample.map(r=>r.detectionToSendMinutes).filter(v=>v!==null);
    return {
      key:s.key,name:s.name,publicationTime:s.publication,
      sampledEvents:sample.length,
      medianDetectionToSendMinutes:median(delays),
      over12Minutes:sample.filter(r=>r.delayed).length,
      withVerifiedPublishTime:sample.filter(r=>r.publicationAt!==null && r.eventType==="NEW").length,
    };
  });
  return {
    checkedAt:new Date().toISOString(), sampledEvents:rows.length, sources:bySource, rows,
    explanation:{
      exactPostTime:"Only DVC Shop exposes verified reservation-level WordPress post dates; post date is not proof of exact first public availability.",
      detectionTime:"For each qualifying NEW/PRICE CHANGE event, queue insertion is when the monitor first recognized the event. It may have seen a listing earlier if it did not qualify for notification.",
      notificationTime:"Sent time is when Brevo accepted the alert (or Rare Finds marked it sent), not Gmail arrival or phone push.",
      priceChanges:"A website's true price-edit timestamp is not exposed by these sources. Price-change detection-to-send can still be measured.",
      limitations:"Rare Finds' legacy ledger retains roughly 60 days and does not retain per-event NEW/CHANGED type. Historical baselines cannot be recreated. Displayed summaries cover up to the requested number of newest alerts for EACH website, not lifetime totals.",
      additionalWebsiteRequests:0,additionalEmails:0,
    },
  };
}
