import { boundedFetch } from "./bounded-fetch.js";
import { EMAIL_LIMITS, URLS, WATCHES } from "./config.js";
import { byId, formatListing } from "./parsers.js";
import { Storage, utcDay } from "./storage.js";
import { withLease } from "./execution-lease.js";

const SOURCE_KEY = "dvcreservations-rare-finds";
const RARE_FINDS_TIMEOUT_MS = 25000;
const RARE_FINDS_FETCH_ATTEMPTS = 3;
const RARE_FINDS_RETRY_DELAY_MS = 750;

export function parseRareFinds(html, now = new Date()) {
  const text = htmlText(html);
  const segments = text.split(/\breserve\b/gi).slice(1);
  const rows = [];

  for (const segmentRaw of segments) {
    const segment = clean(segmentRaw);
    const dates = /(\d{1,2}\/\d{1,2})\s+to\s+(\d{1,2}\/\d{1,2})/i.exec(segment);
    const price = /\$\s*([\d,]+(?:\.\d+)?)\s+a\s+night/i.exec(segment);
    if (!dates || !price) continue;

    const resort = clean(segment.slice(0, dates.index).replace(/^[|\s:–—-]+/, ""));
    if (!resort) continue;

    const roomStart = dates.index + dates[0].length;
    const room = clean(segment.slice(roomStart, price.index).replace(/^[|\s:–—-]+/, "").replace(/[|\s:–—-]+$/, ""));
    const nightly = number(price[1]);
    const checkIn = resolveMonthDay(dates[1], now);
    const checkOut = resolveCheckout(dates[2], checkIn);
    const nights = diffNights(checkIn, checkOut);
    if (!checkIn || !checkOut || !Number.isFinite(nightly) || !Number.isFinite(nights)) continue;

    const afterPrice = clean(segment.slice(price.index + price[0].length).replace(/^[|\s:–—-]+/, ""));
    const notes = clean(afterPrice.replace(/(?=\breserve\b)[\s\S]*$/i, ""));
    const points = number(segment.match(/\b([\d,]+)\s+points?\b/i)?.[1]);
    const listedPointPrice = number(segment.match(/\$\s*([\d.]+)\s*(?:\/\s*|per\s+)?(?:point|pt)\b/i)?.[1]);
    const explicitTotal = number(segment.match(/(?:total(?:\s+cost)?|price)\s*[:=-]?\s*\$\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
    const total = Number.isFinite(explicitTotal) ? explicitTotal : roundMoney(nightly * nights);
    const effectivePointPrice = Number.isFinite(points) && points > 0 ? total / points : null;
    const id = `RARE-${hash([resort.toLowerCase(), checkIn, checkOut, room.toLowerCase()].join("|"))}`;

    rows.push({
      id,
      source: "DVCReservations Rare Finds",
      resort,
      room,
      checkIn,
      checkOut,
      nights,
      nightly,
      total,
      totalDerived: !Number.isFinite(explicitTotal),
      points,
      listedPointPrice,
      effectivePointPrice,
      pointPrice: Number.isFinite(effectivePointPrice) ? effectivePointPrice : listedPointPrice,
      notes,
      status: "Available",
      bookingUrl: URLS.rareFinds,
    });
  }

  return dedupe(rows);
}

export async function runRareFinds(env, now = new Date()) {
  return withLease(env.DB, SOURCE_KEY, async () => {
  const store = new Storage(env.DB);
  try {
    const html = await fetchRareFindsHtml();
    const rows = parseRareFinds(html, now);
    if (!rows.length) throw new Error("DVCReservations Rare Finds parser returned zero reservations");

    const result = await processRareFinds(env, store, rows);
    await store.recordHealth(SOURCE_KEY, true, {
      ok: true,
      count: rows.length,
      baseline: result.baseline,
      alerts: result.alerts,
      deferred: result.deferred,
      under200: rows.filter(row => WATCHES.rentalStoreNightly.match(row)).length,
      under12pt: rows.filter(row => WATCHES.rentalStorePoints.match(row)).length,
    }, null);
    return { ok: true, count: rows.length, ...result };
  } catch (error) {
    const message = errorMessage(error);
    const health = await store.recordHealth(SOURCE_KEY, false, null, message);
    if (health.consecutiveFailures === 3) {
      try {
        await sendSystemEmail(
          env,
          store,
          "DVC Monitor warning — DVCReservations Rare Finds failing",
          `DVCReservations Rare Finds has failed 3 checks in a row after automatic retries. Latest error: ${message}`,
        );
      } catch {
        // Preserve the source error; warning delivery is secondary.
      }
    }
    throw error;
  }
  });
}

async function fetchRareFindsHtml() {
  let lastError = null;
  for (let attempt = 1; attempt <= RARE_FINDS_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await boundedFetch(URLS.rareFindsList, {
        timeoutMs: RARE_FINDS_TIMEOUT_MS,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/2.0)",
        },
      });
      if (!response.ok) throw new Error(`DVCReservations Rare Finds ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < RARE_FINDS_FETCH_ATTEMPTS) {
        await sleep(RARE_FINDS_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError || new Error("DVCReservations Rare Finds request failed");
}

async function processRareFinds(env, store, rows) {
  const previous = await store.getSnapshot(SOURCE_KEY);
  const current = byId(rows);

  if (!previous) {
    await store.putSnapshot(SOURCE_KEY, current);
    return { baseline: true, alerts: 0, deferred: false };
  }

  const events = [];
  for (const listing of rows) {
    const old = previous[listing.id];
    const matches = bargainMatches(listing);
    if (!old) {
      events.push({ type: "NEW", listing, matches });
      continue;
    }
    if (rareFingerprint(old) !== rareFingerprint(listing)) {
      events.push({ type: "CHANGED", listing, previous: old, matches });
    }
  }

  const delivery = await sendRareEvents(env, store, events);
  if (!delivery.deferred && JSON.stringify(previous) !== JSON.stringify(current)) {
    await store.putSnapshot(SOURCE_KEY, current);
  }
  return { baseline: false, alerts: delivery.sent, deferred: delivery.deferred };
}

async function sendRareEvents(env, store, events) {
  if (!events.length) return { sent: 0, deferred: false };

  const priority = events.some(event => event.matches.length > 0);
  const count = await store.getEmailCount();
  if (count >= EMAIL_LIMITS.hardSafetyCutoff || (!priority && count >= EMAIL_LIMITS.lowPriorityCutoff)) {
    return { sent: 0, deferred: true };
  }

  const claimed = [];
  for (const event of events) {
    const fp = rareFingerprint(event.listing);
    const key = `alert:${SOURCE_KEY}:${event.listing.id}:${fp}`;
    if (await store.claimAlert(key, SOURCE_KEY, String(event.listing.id), fp)) {
      claimed.push({ ...event, alertKey: key });
    }
  }
  if (!claimed.length) return { sent: 0, deferred: false };

  try {
    const newCount = claimed.filter(event => event.type === "NEW").length;
    const changedCount = claimed.filter(event => event.type === "CHANGED").length;
    const bits = [
      newCount ? `${newCount} new` : null,
      changedCount ? `${changedCount} changed` : null,
    ].filter(Boolean);
    const subject = bargainSubject(claimed, bits) || `DVCReservations Rare Finds — ${bits.join(", ")}`;

    const blocks = claimed.map(event => {
      const listing = event.listing;
      const previous = event.previous ? `<div style="color:#555;margin-top:4px"><strong>Previous:</strong> ${escapeHtml(formatRareListing(event.previous))}</div>` : "";
      const matches = event.matches.length ? `<div style="margin-top:4px"><strong>Matches:</strong> ${event.matches.map(escapeHtml).join(" + ")}</div>` : "";
      const notes = listing.notes ? `<div style="margin-top:4px"><strong>Notes:</strong> ${escapeHtml(listing.notes)}</div>` : "";
      return `<div style="border-bottom:1px solid #ddd;padding:14px 0;line-height:1.45">
        <strong>${escapeHtml(event.type)}</strong>
        <div>${escapeHtml(formatRareListing(listing))}</div>
        ${matches}
        ${notes}
        ${previous}
        <div style="margin-top:8px"><a href="${escapeHtml(listing.bookingUrl)}">Open Rare Finds / reserve</a><br><span style="font-size:12px;color:#666">${escapeHtml(listing.bookingUrl)}</span></div>
      </div>`;
    }).join("");

    await sendBrevo(env, subject, `<h2>DVCReservations Rare Finds</h2>${blocks}`);
    for (const event of claimed) await store.markAlertSent(event.alertKey);
    const after = await store.incrementEmailCount();
    try { await store.recordWatchEvents(["rareFinds"], claimed); } catch { /* email already delivered */ }
    await maybeCapacityWarning(env, store, after);
    return { sent: claimed.length, deferred: false };
  } catch (error) {
    for (const event of claimed) {
      try { await store.releaseAlert(event.alertKey); } catch { /* pending claims also expire */ }
    }
    throw error;
  }
}

function bargainMatches(listing) {
  const matches = [];
  if (WATCHES.rentalStoreNightly.match(listing)) matches.push(WATCHES.rentalStoreNightly.title);
  if (WATCHES.rentalStorePoints.match(listing)) matches.push(WATCHES.rentalStorePoints.title);
  return matches;
}

function bargainSubject(events, bits) {
  const allMatches = new Set(events.flatMap(event => event.matches));
  const nightly = allMatches.has(WATCHES.rentalStoreNightly.title);
  const points = allMatches.has(WATCHES.rentalStorePoints.title);
  if (!nightly && !points) return null;

  const changePrefix = events.every(event => event.type === "CHANGED") ? "PRICE/RESERVATION CHANGE — " : "";
  const suffix = ` — DVCReservations Rare Finds${bits.length ? ` — ${bits.join(", ")}` : ""}`;
  if (nightly && points) return `🔥🔥 ${changePrefix}DVC RENTAL UNDER $201 + $12/PT 🔥🔥${suffix}`;
  if (nightly) return `🔥 ${changePrefix}DVC RENTAL UNDER $201 🔥${suffix}`;
  return `🔥 ${changePrefix}DVC RENTAL UNDER $12/PT 🔥${suffix}`;
}

function rareFingerprint(row) {
  return JSON.stringify([
    clean(row.resort),
    clean(row.room),
    row.checkIn || "",
    row.checkOut || "",
    number(row.nights),
    roundMoney(number(row.nightly)),
    roundMoney(number(row.total)),
    number(row.points),
    roundMoney(number(row.effectivePointPrice)),
    roundMoney(number(row.listedPointPrice)),
    clean(row.notes),
  ]);
}

function formatRareListing(row) {
  const base = formatListing(row);
  if (row.totalDerived && Number.isFinite(row.total)) {
    return base.replace(`${money(row.total)} total`, `${money(row.total)} full-stay total`);
  }
  return base;
}

async function sendSystemEmail(env, store, subject, text) {
  const count = await store.getEmailCount();
  if (count >= EMAIL_LIMITS.hardSafetyCutoff) return;
  await sendBrevo(env, subject, `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`);
  await store.incrementEmailCount();
}

async function maybeCapacityWarning(env, store, currentCount) {
  if (currentCount < EMAIL_LIMITS.warningAt) return;
  const key = `email-capacity-warning:${utcDay()}`;
  if (await store.getMeta(key)) return;
  try {
    await sendBrevo(
      env,
      "DVC Monitor email-capacity warning",
      `<p>The monitor has sent ${currentCount} emails today. Low-priority alerts pause at ${EMAIL_LIMITS.lowPriorityCutoff}; bargain alerts remain enabled until the ${EMAIL_LIMITS.hardSafetyCutoff} safety cutoff.</p>`,
    );
    await store.incrementEmailCount();
    await store.putMeta(key, { sentAt: new Date().toISOString(), countBeforeWarning: currentCount });
  } catch {
    // Reservation delivery succeeded; capacity-warning failure should not roll it back.
  }
}

async function sendBrevo(env, subject, htmlBody) {
  if (!env.BREVO_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) {
    throw new Error("Email is not configured: BREVO_API_KEY, EMAIL_TO and EMAIL_FROM are required");
  }
  const response = await boundedFetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || "DVC Monitor" },
      to: [{ email: env.EMAIL_TO }],
      ...(env.PUSHOVER_EMAIL ? { bcc: [{ email: env.PUSHOVER_EMAIL }] } : {}),
      subject,
      htmlContent: `<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;padding:18px">${htmlBody}</body></html>`,
      tags: ["dvc-monitor", "rare-finds"],
    }),
  });
  if (!response.ok) throw new Error(`Brevo ${response.status}: ${(await response.text()).slice(0, 250)}`);
}

function resolveMonthDay(value, now) {
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = now.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  const grace = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 14 * 86400000);
  if (candidate < grace) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate.toISOString().slice(0, 10);
}

function resolveCheckout(value, checkIn) {
  if (!checkIn) return null;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const [startYear, startMonth, startDay] = checkIn.split("-").map(Number);
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = startYear;
  if (month < startMonth || (month === startMonth && day < startDay)) year += 1;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function diffNights(a, b) {
  if (!a || !b) return null;
  const nights = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return nights > 0 ? nights : null;
}

function htmlText(html) {
  return clean(decode(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")));
}

function decode(value = "") {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rarr;|&#8594;/gi, "→")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) map.set(String(row.id), row);
  return [...map.values()].sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)) || String(a.id).localeCompare(String(b.id)));
}

function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function money(value) {
  const rounded = roundMoney(value);
  return Number.isFinite(rounded) ? `$${rounded.toLocaleString("en-US", { minimumFractionDigits: rounded % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : "";
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(36).toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
