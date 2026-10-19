import { boundedFetch } from "./bounded-fetch.js";
import { dailyCadenceReport } from "./daily-cadence-report.js";
import { URLS, WATCHES, EMAIL_LIMITS, SOURCE_EXPECTED_MINUTES } from "./config.js";
import { parseKeyholder, parseExternalRentalStore, parseDavids, parseDvcShop, fingerprint, formatListing, priceSummary, byId } from "./parsers.js";
import { Storage, utcDay } from "./storage.js";
import { withLease } from "./execution-lease.js";
import { assertInventoryHealthy } from "./inventory-guard.js";
import { enqueueOutbox, claimOutbox, markOutboxSent, markOutboxUncertain, requeueOutbox, quarantineExpiredSends } from "./alert-outbox.js";

const RENTAL_STORE_BACKUP_WORKFLOW = "dvc-rental-store-website-backup.yml";
const GITHUB_REPO = "ATLBravesFan/dvc-reservation-monitor";

export default {
  async scheduled(event, env, ctx) {
    runScheduled(env, new Date(event.scheduledTime || Date.now()), ctx);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const store = new Storage(env.DB);

    if (url.pathname === "/" || url.pathname === "/health") {
      return statusResponse(env, store, url.pathname === "/");
    }

    if (url.pathname === "/diagnostics/daily-cadence" && request.method === "GET") {
      if (!authorized(request, env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      try {
        return json(await dailyCadenceReport(env.DB, url.searchParams.get("day")));
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 400);
      }
    }

    if (url.pathname === "/diagnostics/executions" && request.method === "GET") {
      if (!authorized(request, env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const sources = ["dvc-shop", "davids", "rental-store-api"];
      const leases = (await env.DB.prepare(
        "SELECT source,acquired_at,expires_at FROM execution_leases WHERE source IN ('dvc-shop','davids','rental-store-api') ORDER BY source"
      ).all()).results || [];
      const history = (await env.DB.prepare(
        "SELECT source,started_at,finished_at,outcome,error FROM execution_history WHERE source IN ('dvc-shop','davids','rental-store-api') ORDER BY started_at DESC LIMIT 90"
      ).all()).results || [];
      const health = (await store.allHealth()).filter(row => sources.includes(row.source));
      return json({ checkedAt: new Date().toISOString(), health, leases, history });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!authorized(request, env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const mode = url.searchParams.get("mode") || "all";
      return json(await runManual(env, store, mode));
    }

    if (url.pathname === "/ingest/dvc-rental-store-website" && request.method === "POST") {
      if (!authorized(request, env.INGEST_TOKEN || env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const rows = Array.isArray(body) ? body : body.listings;
      if (!Array.isArray(rows)) return json({ ok: false, error: "Expected listings array" }, 400);
      const parsed = parseExternalRentalStore(rows);
      if (!parsed.length) return json({ ok: false, error: "No usable Rental Store website reservations" }, 400);
      const result = await tracked(env, store, "rental-store-website", () => processRentalStoreWebsite(env, store, parsed));
      return json(result?.skipped ? { ok: false, ...result } : { ok: true, ...result }, result?.skipped ? 409 : 200);
    }

    if (url.pathname === "/ingest/dvc-rental" && request.method === "POST") {
      if (!authorized(request, env.INGEST_TOKEN || env.ADMIN_TOKEN)) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const rows = Array.isArray(body) ? body : body.listings;
      if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: "Expected non-empty listings array" }, 400);
      const normalized = normalizeBrowserRows(rows, "DVC-Rental");
      if (!normalized.length) return json({ ok: false, error: "No usable DVC-Rental reservations" }, 400);
      const result = await tracked(env, store, "dvc-rental", () => processStandardWatch(env, store, "dvc-rental", WATCHES.dvcRental, normalized));
      if (!result?.skipped && request.headers.get("X-DVC-Ingest-Origin") !== "direct") {
        await store.recordHealth("dvc-rental-browser-ingest", true, { count: normalized.length }, null);
      }
      return json(result?.skipped ? { ok: false, ...result } : { ok: true, ...result }, result?.skipped ? 409 : 200);
    }

    return new Response("DVC monitor is running. Open / for status.");
  },
};

function runScheduled(env, now, ctx) {
  const store = new Storage(env.DB);
  const minute = now.getUTCMinutes();
  const fiveMinuteCycle = minute % 5 === 0;
  const tenMinuteCycle = minute % 10 === 0;

  // Crucial: register each watch independently. Never make a scheduled
  // invocation wait for all sources or for a shared D1 heartbeat.
  // An indefinitely stalled watch cannot hold other checks hostage.
  ctx.waitUntil(drainOutbox(env, store, 20).catch(error => console.error("outbox drain failed",errorMessage(error))));
  const jobs = [
    ["rentalStore", () => tracked(env, store, "rental-store-api", () => pollRentalStore(env, store, false))],
    ["dvcShop", () => pollDvcShop(env, store)],
  ];
  if (tenMinuteCycle) jobs.push(["rentalStoreAll", () => runManual(env, store, "rental-store-all")]);
  if (fiveMinuteCycle) {
    jobs.push(["rentalStoreWebsiteDispatch", () => tracked(env, store, "rental-store-website-dispatch", () => dispatchRentalStoreWebsiteBackup(env))]);
    jobs.push(["davids", () => pollDavids(env, store)]);
  }

  // The heartbeat is non-critical; it must never block scheduling.
  ctx.waitUntil(store.putMeta("last-scheduled-start", {
    scheduledAt: now.toISOString(), startedAt: new Date().toISOString(),
    jobs: jobs.map(([name]) => name),
  }).catch(error => console.error("scheduler heartbeat failed", errorMessage(error))));

  for (const [name, run] of jobs) {
    ctx.waitUntil((async () => {
      try {
        const result = await run();
        // Source health is recorded independently by tracked().
        // Keep this summary for the existing dashboard, but it is advisory.
        await store.putMeta("last-scheduled", {
          source: name, result, scheduledAt: now.toISOString(),
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error("scheduled watch failed", name, errorMessage(error));
      }
    })());
  }

  if (minute === 7) {
    ctx.waitUntil(store.cleanupExpiredAlerts().catch(error =>
      console.error("alert cleanup failed", errorMessage(error))));
  }
}

async function runManual(env, store, mode) {
  if (mode === "rental-store-all") {
    // Recover the 10-minute all-inventory watch independently of the fast API poll lease.
    // The fast watch runs every minute and can otherwise starve this recovery.
    return { rentalStoreAll: await tracked(env, store, "rental-store-all", async () => {
      const response = await boundedFetch(URLS.rentalStoreApi, {
        headers: { Accept: "application/json", "User-Agent": "DVC-Monitor/2.0" },
      });
      if (!response.ok) throw new Error(`Keyholder API ${response.status}`);
      const rows = parseKeyholder(await response.json());
      validateRentalStoreRows(rows);
      return processRentalStoreAllWatch(env, store, rows);
    }) };
  }
  if (mode === "rental-store") {
    return { rentalStore: await tracked(env, store, "rental-store-api", () => pollRentalStore(env, store, true)) };
  }
  if (mode === "website-backup-dispatch") {
    return { rentalStoreWebsiteDispatch: await tracked(env, store, "rental-store-website-dispatch", () => dispatchRentalStoreWebsiteBackup(env)) };
  }
  if (mode === "slow") return { slower: await pollSlowerHttpSources(env, store) };
  if (mode === "dvc-shop") return { dvcShop: await pollDvcShop(env, store) };
  if (mode === "davids") return { davids: await pollDavids(env, store) };
  if (mode === "drain-outbox") return { outbox: await drainOutbox(env,store,20) };
  if (mode === "test-email") {
    await sendSystemEmail(env, store, "DVC Monitor test email", "The DVC monitor email connection is working.");
    return { testEmail: { ok: true } };
  }
  return {
    rentalStore: await tracked(env, store, "rental-store-api", () => pollRentalStore(env, store, true)),
    rentalStoreWebsiteDispatch: await tracked(env, store, "rental-store-website-dispatch", () => dispatchRentalStoreWebsiteBackup(env)),
    slower: await pollSlowerHttpSources(env, store),
  };
}

async function tracked(env, store, source, fn) {
  return withLease(env.DB, source, async () => {
  try {
    const value = await fn();
    await store.recordHealth(source, true, summarizeForHealth(value), null);
    return value;
  } catch (error) {
    const message = errorMessage(error);
    const health = await store.recordHealth(source, false, null, message);
    if (health.consecutiveFailures === 3) {
      try {
        await sendSystemEmail(
          env,
          store,
          `DVC Monitor warning — ${source} failing`,
          `${source} has failed 3 checks in a row. Latest error: ${message}\n\nOpen the Worker status page for current health details.`,
        );
      } catch {
        // Never replace the original source error with a warning-email error.
      }
    }
    throw error;
  }
  });
}

async function dispatchRentalStoreWebsiteBackup(env) {
  if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN not configured");

  const response = await boundedFetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${RENTAL_STORE_BACKUP_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DVC-Reservation-Monitor",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (response.status !== 204) {
    throw new Error(`GitHub workflow dispatch ${response.status}: ${(await response.text()).slice(0, 250)}`);
  }
  return { ok: true, dispatchedAt: new Date().toISOString() };
}

async function pollRentalStore(env, store, includeAllReservationsWatch = false) {
  const response = await boundedFetch(URLS.rentalStoreApi, {
    headers: { Accept: "application/json", "User-Agent": "DVC-Monitor/2.0" },
  });
  if (!response.ok) throw new Error(`Keyholder API ${response.status}`);

  const rows = parseKeyholder(await response.json());
  validateRentalStoreRows(rows);

  const fast = await processRentalStoreFast(env, store, rows);
  let allReservations10m = null;
  if (includeAllReservationsWatch) {
    allReservations10m = await tracked(env, store, "rental-store-all", () => processRentalStoreAllWatch(env, store, rows));
  }

  return {
    ok: true,
    count: rows.length,
    under200: rows.filter(WATCHES.rentalStoreNightly.match).length,
    under12pt: rows.filter(WATCHES.rentalStorePoints.match).length,
    fast,
    ...(allReservations10m ? { allReservations10m } : {}),
  };
}

function validateRentalStoreRows(rows) {
  if (!rows.length) throw new Error("Keyholder API returned zero usable reservations");
  const complete = rows.filter(r => r.id && r.checkIn && Number.isFinite(r.total) && Number.isFinite(r.points)).length;
  if (complete / rows.length < 0.85) {
    throw new Error(`Keyholder API completeness check failed: ${complete}/${rows.length} rows had ID/date/price/points`);
  }
}

async function processRentalStoreFast(env, store, rows) {
  const key = "rental-store-fast";
  const previous = await store.getSnapshot(key);
  assertInventoryHealthy(previous, rows, key);
  const current = byId(rows);

  if (!previous) {
    await store.putSnapshot(key, current);
    return { baseline: true, alerts: 0 };
  }

  const events = [];
  for (const listing of rows) {
    const matches = bargainMatches(listing);
    if (!matches.length) continue;
    const old = previous[listing.id];
    if (!old) events.push({ type: "NEW", listing, matches });
    else if (fingerprint(old) !== fingerprint(listing)) events.push({ type: "PRICE CHANGE", listing, previous: old, matches });
  }

  const delivery = await sendEvents(env, store, "dvc-rental-store", "DVC Rental Store", events, true);
  if (!delivery.deferred) await putSnapshotIfChanged(store, key, previous, current);
  return { baseline: false, alerts: delivery.sent, deferred: delivery.deferred };
}

async function processRentalStoreAllWatch(env, store, rows) {
  const key = "rental-store-all";
  const previous = await store.getSnapshot(key);
  assertInventoryHealthy(previous, rows, key);
  const current = byId(rows);

  if (!previous) {
    await store.putSnapshot(key, current);
    return { ok: true, count: rows.length, baseline: true, alerts: 0 };
  }

  const events = [];
  for (const listing of rows) {
    const matches = bargainMatches(listing);
    const old = previous[listing.id];
    if (!old) events.push({ type: "NEW", listing, matches });
    else if (WATCHES.rentalStoreAll.priceChanges && fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old, matches });
    }
  }

  const delivery = await sendEvents(env, store, "dvc-rental-store", WATCHES.rentalStoreAll.title, events, true);
  if (!delivery.deferred) await putSnapshotIfChanged(store, key, previous, current);
  return { ok: true, count: rows.length, baseline: false, alerts: delivery.sent, deferred: delivery.deferred };
}

function bargainMatches(listing) {
  const matches = [];
  if (WATCHES.rentalStoreNightly.match(listing)) matches.push(WATCHES.rentalStoreNightly.title);
  if (WATCHES.rentalStorePoints.match(listing)) matches.push(WATCHES.rentalStorePoints.title);
  return matches;
}

async function processRentalStoreWebsite(env, store, rows) {
  const key = "rental-store-website";
  const previous = await store.getSnapshot(key);
  assertInventoryHealthy(previous, rows, key);
  const current = byId(rows);
  const qualifying = rows.filter(r => bargainMatches(r).length > 0);

  if (!previous) {
    await store.putSnapshot(key, current);
    return {
      baseline: true,
      count: rows.length,
      qualifying: qualifying.length,
      under200: rows.filter(WATCHES.rentalStoreNightly.match).length,
      under12pt: rows.filter(WATCHES.rentalStorePoints.match).length,
      alerts: 0,
    };
  }

  const events = [];
  for (const listing of rows) {
    const matches = bargainMatches(listing);
    const old = previous[listing.id];
    if (!old) events.push({ type: "NEW", listing, matches });
    else if (WATCHES.rentalStoreAll.priceChanges && fingerprint(old) !== fingerprint(listing)) {
      events.push({ type: "PRICE CHANGE", listing, previous: old, matches });
    }
  }

  const delivery = await sendEvents(env, store, "dvc-rental-store", WATCHES.rentalStoreAll.title, events, true);
  if (!delivery.deferred) await putSnapshotIfChanged(store, key, previous, current);

  return {
    baseline: false,
    count: rows.length,
    qualifying: qualifying.length,
    under200: rows.filter(WATCHES.rentalStoreNightly.match).length,
    under12pt: rows.filter(WATCHES.rentalStorePoints.match).length,
    alerts: delivery.sent,
    deferred: delivery.deferred,
  };
}

async function pollDavids(env, store) {
  try {
    return await tracked(env, store, "davids", async () => {
      const rows = parseDavids(await fetchText(URLS.davids));
      if (!rows.length) throw new Error("David's parser returned zero reservations");
      return processStandardWatch(env, store, "davids", WATCHES.davids, rows);
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function pollDvcShop(env, store) {
  try {
    return await tracked(env, store, "dvc-shop", async () => {
      const rows = parseDvcShop(await fetchText(URLS.dvcShop));
      if (!rows.length) throw new Error("DVC Shop parser returned zero reservations");
      return processStandardWatch(env, store, "dvc-shop", WATCHES.dvcShop, rows);
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function pollSlowerHttpSources(env, store) {
  return {
    davids: await pollDavids(env, store),
    dvcShop: await pollDvcShop(env, store),
  };
}

async function processStandardWatch(env, store, key, watch, rows) {
  const previous = await store.getSnapshot(key);
  assertInventoryHealthy(previous, rows, key);
  const current = byId(rows);

  if (!previous) {
    await store.putSnapshot(key, current);
    return { ok: true, count: rows.length, baseline: true, alerts: 0 };
  }

  const events = [];
  for (const listing of rows) {
    if (!watch.match(listing)) continue;
    const matches = bargainMatches(listing);
    const old = previous[listing.id];
    if (!old) {
      events.push({ type: "NEW", listing, matches });
      continue;
    }

    if (fingerprint(old) === fingerprint(listing)) continue;
    const oldMatches = bargainMatches(old);
    const gainedBargain = matches.some(match => !oldMatches.includes(match));
    if (watch.priceChanges || gainedBargain) {
      events.push({ type: "PRICE CHANGE", listing, previous: old, matches });
    }
  }

  const delivery = await sendEvents(env, store, key, watch.title, events, true);
  if (!delivery.deferred) await putSnapshotIfChanged(store, key, previous, current);
  return { ok: true, count: rows.length, baseline: false, alerts: delivery.sent, deferred: delivery.deferred };
}

async function sendEvents(env, store, source, title, events, showMatches) {
  if (!events.length) return { sent: 0, deferred: false };
  // Persist before advancing snapshots. Repeated source polls cannot create duplicate keys.
  for (const event of events) {
    const key = alertKey(source, event.listing);
    const existing = await env.DB.prepare("SELECT status FROM alerts WHERE alert_key=?").bind(key).first();
    if (existing?.status === "sent") continue;
    await enqueueOutbox(env.DB, { key, source, listingId: event.listing.id, event,
      title, showMatches, priority: (event.matches || bargainMatches(event.listing)).length > 0 });
  }
  // The scheduled delivery worker runs separately, so Brevo latency cannot delay source checks.
  return { sent: 0, queued: events.length, deferred: false };
}

async function drainOutbox(env, store, limit = 20) {
  return withLease(env.DB, 'alert-outbox-drain', async () => {
  await quarantineExpiredSends(env.DB);
  const rows = (await env.DB.prepare(`SELECT * FROM alert_outbox WHERE status='pending'
    AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    ORDER BY priority DESC,created_at ASC LIMIT ?`)
    .bind(new Date().toISOString(),limit).all()).results || [];
  let sent = 0;
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.source,row.title,row.show_matches,row.priority]);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  for (const candidates of groups.values()) {
    const count = await store.getEmailCount();
    if (count >= EMAIL_LIMITS.hardSafetyCutoff) break;
    if (!candidates[0].priority && count >= EMAIL_LIMITS.lowPriorityCutoff) continue;
    const claimed = [];
    for (const row of candidates) {
      if (await claimOutbox(env.DB,row.alert_key)) claimed.push(row);
    }
    if (!claimed.length) continue;
    const valid = [];
    for (const row of claimed) {
      try { valid.push({row,event:JSON.parse(row.payload)}); }
      catch (error) {
        await markOutboxUncertain(env.DB,row.alert_key,"Invalid stored alert payload: "+errorMessage(error));
      }
    }
    if (!valid.length) continue;
    let providerCalled = false;
    try {
      if (!env.BREVO_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) {
        for (const {row} of valid) await requeueOutbox(env.DB,row.alert_key,"Email configuration missing",300);
        continue;
      }
      providerCalled = true;
      await sendEmail(env,valid[0].row.title || valid[0].row.source,valid.map(x=>x.event),Boolean(valid[0].row.show_matches));
      // One Brevo email may contain many reservations. All claims share its delivery outcome.
      for (const {row} of valid) {
        await markOutboxSent(env.DB,row.alert_key);
        try { await store.markAlertSent(row.alert_key); } catch (error) { console.error("legacy alert ledger update failed",errorMessage(error)); }
      }
      let after;
      try { after = await store.incrementEmailCount(); } catch (error) { console.error("email count update failed",errorMessage(error)); after = 0; }
      sent++;
      try {
        for (const {row,event} of valid) {
          const watchKeys = row.source === "dvc-rental-store"
            ? ["rentalStoreAll",...(WATCHES.rentalStoreNightly.match(event.listing)?["rentalStoreNightly"]:[]),
               ...(WATCHES.rentalStorePoints.match(event.listing)?["rentalStorePoints"]:[])]
            : [row.source === "dvc-rental"?"dvcRental":row.source === "dvc-shop"?"dvcShop":row.source];
          await store.recordWatchEvents(watchKeys,[event]);
        }
        await maybeSendEmailCapacityWarning(env,store,after);
      } catch (error) { console.error("post-send metadata failed",errorMessage(error)); }
    } catch (error) {
      for (const {row} of valid) {
        if (error?.providerRejected && (error.status === 429 || error.status >= 500)) {
          await requeueOutbox(env.DB,row.alert_key,errorMessage(error),Math.min(3600,60*2**Math.min(row.attempts,5)));
        } else if (providerCalled) await markOutboxUncertain(env.DB,row.alert_key,errorMessage(error));
        else await requeueOutbox(env.DB,row.alert_key,errorMessage(error));
      }
      console.error("outbox delivery requires review",valid.length,errorMessage(error));
    }
  }
  return { sent, inspected: rows.length };
  }, 120);
}

function alertKey(source, listing) {
  return `alert:${source}:${listing.id}:${fingerprint(listing)}`;
}

function priorityBargainSubject(title, events, subjectBits) {
  const matches = new Set(events.flatMap(event => event.matches || bargainMatches(event.listing)));
  const nightly = matches.has(WATCHES.rentalStoreNightly.title);
  const points = matches.has(WATCHES.rentalStorePoints.title);
  if (!nightly && !points) return null;

  const onlyPriceChanges = events.every(event => event.type === "PRICE CHANGE");
  const statusPrefix = onlyPriceChanges ? "PRICE CHANGE — " : "";
  const sourceSuffix = title && title !== "DVC Rental Store" ? ` — ${title}` : "";
  const countSuffix = onlyPriceChanges || !subjectBits.length ? "" : ` — ${subjectBits.join(", ")}`;

  if (nightly && points) return `🔥🔥 ${statusPrefix}DVC RENTAL UNDER $201 + $12/PT 🔥🔥${sourceSuffix}${countSuffix}`;
  if (nightly) return `🔥 ${statusPrefix}DVC RENTAL UNDER $201 🔥${sourceSuffix}${countSuffix}`;
  return `🔥 ${statusPrefix}DVC RENTAL UNDER $12/PT 🔥${sourceSuffix}${countSuffix}`;
}

async function sendEmail(env, title, events, showMatches) {
  const newCount = events.filter(event => event.type === "NEW").length;
  const changedCount = events.length - newCount;
  const subjectBits = [
    newCount ? `${newCount} new` : null,
    changedCount ? `${changedCount} price change${changedCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const subject = priorityBargainSubject(title, events, subjectBits) || `${title} — ${subjectBits.join(", ")}`;

  const blocks = events.map(event => {
    const listing = event.listing;
    return `<div style="border-bottom:1px solid #ddd;padding:14px 0;line-height:1.45">
      <strong>${escapeHtml(event.type)}</strong>
      <div>${escapeHtml(formatListing(listing))}</div>
      ${showMatches && event.matches?.length ? `<div><strong>Matches:</strong> ${event.matches.map(escapeHtml).join(" + ")}</div>` : ""}
      ${event.previous ? `<div style="color:#555">Previous: ${escapeHtml(priceSummary(event.previous))}</div>` : ""}
      ${listing.bookingUrl ? `<div style="margin-top:7px"><a href="${escapeHtml(listing.bookingUrl)}">Book this reservation</a><br><span style="font-size:12px;color:#666">${escapeHtml(listing.bookingUrl)}</span></div>` : ""}
    </div>`;
  }).join("");

  await sendBrevo(env, subject, `<h2>${escapeHtml(title)}</h2>${blocks}`);
}

async function sendSystemEmail(env, store, subject, text) {
  const count = await store.getEmailCount();
  if (count >= EMAIL_LIMITS.hardSafetyCutoff) throw new Error("Email safety cutoff reached");
  await sendBrevo(env, subject, `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`);
  await store.incrementEmailCount();
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
      subject,
      htmlContent: `<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;padding:18px">${htmlBody}</body></html>`,
      tags: ["dvc-monitor"],
    }),
  });

  if (!response.ok) {
    const error = new Error(`Brevo ${response.status}: ${(await response.text()).slice(0, 250)}`);
    error.providerRejected = true;
    error.status = response.status;
    throw error;
  }
}

async function maybeSendEmailCapacityWarning(env, store, currentCount) {
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
    // Reservation alerts have already been sent. Warning failure must not roll them back.
  }
}

async function statusResponse(env, store, html) {
  const health = await store.allHealth();
  const now = Date.now();
  const healthWithStale = health.map(item => {
    const expected = SOURCE_EXPECTED_MINUTES[item.source];
    const checkedAt = Date.parse(item.lastCheckedAt || "");
    const stale = expected ? (!Number.isFinite(checkedAt) || now - checkedAt > expected * 60_000) : false;
    return { ...item, expectedMinutes: expected || null, stale };
  });
  const outboxCounts = (await env.DB.prepare("SELECT status, COUNT(*) AS count FROM alert_outbox GROUP BY status").all()).results || [];
  const outbox = Object.fromEntries(outboxCounts.map(item => [item.status, Number(item.count)]));
  const emailCount = await store.getEmailCount();
  const watchKeys = Object.keys(WATCHES);
  const watchActivity = await Promise.all(watchKeys.map(key => store.getMeta(`watch-events:${key}`)));
  const lastScheduled = await store.getMeta("last-scheduled");
  const lastScheduledStart = await store.getMeta("last-scheduled-start");
  const degraded = healthWithStale.some(item => !item.ok || item.stale || item.consecutiveFailures >= 3) || (outbox.uncertain || 0) > 0;

  const payload = {
    ok: !degraded,
    storage: "Cloudflare D1",
    cron: "every minute",
    watches: Object.entries(WATCHES).map(([key, watch], index) => ({
      key,
      title: watch.title,
      interval: watch.interval,
      priceChanges: watch.priceChanges,
      lastAddedAt: watchActivity[index]?.lastAddedAt || null,
      lastChangedAt: watchActivity[index]?.lastChangedAt || null,
      lastActivityAt: watchActivity[index]?.lastActivityAt || null,
    })),
    rentalStoreWebsiteBackup: {
      requestedInterval: "5 minutes",
      trigger: "Cloudflare Worker dispatches GitHub browser workflow",
      githubCronFallback: "15 minutes",
    },
    alertOutbox: { pending: outbox.pending || 0, sending: outbox.sending || 0,
      sent: outbox.sent || 0, uncertain: outbox.uncertain || 0 },
    emailUsageToday: {
      sent: emailCount,
      providerDailyLimit: EMAIL_LIMITS.providerDaily,
      warningAt: EMAIL_LIMITS.warningAt,
      lowPriorityCutoff: EMAIL_LIMITS.lowPriorityCutoff,
      hardSafetyCutoff: EMAIL_LIMITS.hardSafetyCutoff,
    },
    health: healthWithStale,
    lastScheduled,
    lastScheduledStart,
    checkedAt: new Date().toISOString(),
  };

  if (!html) return json(payload);
  const rows = healthWithStale.map(item => `<tr>
    <td>${escapeHtml(item.source)}</td>
    <td>${item.ok && !item.stale ? "OK" : "CHECK"}</td>
    <td>${escapeHtml(item.lastCheckedAt || "never")}</td>
    <td>${escapeHtml(item.lastSuccessAt || "never")}</td>
    <td>${item.consecutiveFailures}</td>
    <td>${escapeHtml(item.lastError || "")}</td>
  </tr>`).join("");

  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>DVC Monitor</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:1100px;margin:30px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px;overflow:auto}.bad{font-weight:700}</style></head><body>
  <h1>DVC Monitor</h1><p class="${degraded ? "bad" : ""}">Overall status: ${degraded ? "CHECK REQUIRED" : "OK"}</p>
  <p>Email sends today: ${emailCount} / ${EMAIL_LIMITS.providerDaily}. D1 storage is active.</p>
  <table><thead><tr><th>Source</th><th>Status</th><th>Last check</th><th>Last success</th><th>Failures</th><th>Last error</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Reservation watches</h2>
  <p>Last added and last changed show when a matching reservation alert was successfully sent. Empty means no recorded alert since this feature was enabled.</p>
  <table><thead><tr><th>Watch</th><th>Interval</th><th>Last added</th><th>Last changed</th></tr></thead><tbody>${payload.watches.map(watch => `<tr><td>${escapeHtml(watch.title)}</td><td>${escapeHtml(watch.interval)}</td><td class="time" data-utc="${escapeHtml(watch.lastAddedAt || "")}">${escapeHtml(watch.lastAddedAt || "—")}</td><td class="time" data-utc="${escapeHtml(watch.lastChangedAt || "")}">${escapeHtml(watch.lastChangedAt || "—")}</td></tr>`).join("")}</tbody></table>
  <script>document.querySelectorAll(".time[data-utc]").forEach(cell => { const value = cell.dataset.utc; if (value) cell.textContent = new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" }) + " ET"; });</script>
  <h2>Details</h2><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></body></html>`, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

async function putSnapshotIfChanged(store, key, previous, current) {
  if (JSON.stringify(previous) !== JSON.stringify(current)) await store.putSnapshot(key, current);
}

export function normalizeBrowserRows(rows, source) {
  return rows.map(row => ({
    id: String(row.id || "").trim(),
    source,
    resort: String(row.resort || "").trim(),
    room: String(row.room || row.roomType || "").trim(),
    checkIn: row.checkIn || null,
    checkOut: row.checkOut || null,
    nights: numberOrNull(row.nights),
    total: numberOrNull(row.total),
    nightly: numberOrNull(row.nightly),
    pointPrice: numberOrNull(row.pointPrice),
    listedPointPrice: numberOrNull(row.listedPointPrice),
    effectivePointPrice: numberOrNull(row.effectivePointPrice),
    points: numberOrNull(row.points),
    status: row.status || "Available",
    bookingUrl: row.bookingUrl || null,
  })).filter(row => row.id && (row.resort || row.room || row.checkIn));
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchText(url) {
  const response = await boundedFetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/2.0)",
    },
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.text();
}

function summarizeForHealth(value) {
  if (!value || typeof value !== "object") return value;
  const keys = ["ok", "count", "baseline", "alerts", "deferred", "under200", "under12pt", "qualifying", "dispatchedAt"];
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function authorized(request, token) {
  return Boolean(token) && (request.headers.get("authorization") || "") === `Bearer ${token}`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}