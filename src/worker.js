import { boundedFetch } from "./bounded-fetch.js";
import baseWorker from "./index.js";
import { URLS } from "./config.js";
import { parseDvcRentalDealsHtml } from "./dvc-rental-direct.js";
import { runRareFinds } from "./rare-finds.js";
import { Storage } from "./storage.js";
import { withLease } from "./execution-lease.js";

const GITHUB_REPO = "ATLBravesFan/dvc-reservation-monitor";
const DVC_RENTAL_WORKFLOW = "dvc-rental-browser.yml";

export default {
  async scheduled(event, env, ctx) {
    baseWorker.scheduled(event, env, ctx);

    const now = new Date(event.scheduledTime || Date.now());
    const minute = now.getUTCMinutes();

    // DVC-Rental exposes its complete structured reservation inventory inside
    // the server-rendered Next.js response. Use that lightweight direct source
    // as primary, while preserving the existing Chromium workflow as a backup.
    if (minute % 5 === 0) {
      ctx.waitUntil(runDvcRentalDirect(env, now));
    }

    if (minute % 10 === 0) {
      ctx.waitUntil(dispatchDvcRentalBrowser(env, now));
    } else {
      // Check recovery each minute so a missed 10-minute dispatch does not
      // wait for the next five-minute boundary. Dispatch remains throttled.
      ctx.waitUntil(recoverStaleDvcRentalBrowser(env, now));
    }

    if (minute % 15 === 0) {
      ctx.waitUntil(runRareFinds(env, now));
    }

    // Recover overdue HTTP sources even if GitHub scheduled Actions are delayed.
    // Existing D1 source leases prevent concurrent checks from duplicating work.
    if (minute % 5 === 2) {
      ctx.waitUntil(recoverOverdueSources(env, now).catch(error =>
        console.error("scheduled source recovery failed", error instanceof Error ? error.message : String(error))));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST" && url.searchParams.get("mode") === "dvc-rental-dispatch") {
      if (!env.ADMIN_TOKEN || (request.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("Unauthorized", { status: 401 });
      const result = await dispatchDvcRentalBrowser(env, new Date());
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/run" && request.method === "POST" && url.searchParams.get("mode") === "dvc-rental-direct") {
      if (!env.ADMIN_TOKEN || (request.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await runDvcRentalDirect(env, new Date());
      return new Response(JSON.stringify({ dvcRentalDirect: result }, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    }

    if (url.pathname === "/run" && request.method === "POST" && url.searchParams.get("mode") === "rare-finds") {
      if (!env.ADMIN_TOKEN || (request.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await runRareFinds(env, new Date());
        return new Response(JSON.stringify({ rareFinds: result }, null, 2), {
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ rareFinds: { ok: false, error: error instanceof Error ? error.message : String(error) } }, null, 2), {
          status: 500,
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      }
    }

    return baseWorker.fetch(request, env);
  },
};

async function runDvcRentalDirect(env, now) {
  const store = new Storage(env.DB);
  try {
    const response = await boundedFetch(URLS.dvcRental, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/2.0)",
      },
    });
    if (!response.ok) throw new Error(`DVC-Rental direct HTTP ${response.status}`);

    const html = await response.text();
    const rows = parseDvcRentalDealsHtml(html);
    if (!rows.length) throw new Error("DVC-Rental direct parser returned zero reservations");

    const complete = rows.filter(row =>
      row.id && row.checkIn && row.checkOut && Number.isFinite(row.nights) &&
      Number.isFinite(row.total) && Number.isFinite(row.points)
    ).length;
    if (complete !== rows.length) {
      throw new Error(`DVC-Rental direct completeness failed: ${complete}/${rows.length}`);
    }

    const reportedCount = Number(html.match(/(\d+)\s+confirmed reservations/i)?.[1] || NaN);
    if (Number.isFinite(reportedCount) && reportedCount !== rows.length) {
      throw new Error(`DVC-Rental direct count mismatch: site reports ${reportedCount}, parsed ${rows.length}`);
    }

    const token = env.INGEST_TOKEN || env.ADMIN_TOKEN;
    if (!token) throw new Error("DVC-Rental direct ingest token is not configured");

    // Reuse the existing ingestion/alert path so the direct source and browser
    // fallback share one D1 snapshot and one deduplication namespace.
    const ingestResponse = await baseWorker.fetch(new Request("https://dvc-monitor.internal/ingest/dvc-rental", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-DVC-Ingest-Origin": "direct",
      },
      body: JSON.stringify({ listings: rows }),
    }), env);
    const ingestText = await ingestResponse.text();
    if (!ingestResponse.ok) {
      throw new Error(`DVC-Rental direct ingest ${ingestResponse.status}: ${ingestText.slice(0, 500)}`);
    }

    let ingest = null;
    try { ingest = JSON.parse(ingestText); } catch { ingest = { response: ingestText.slice(0, 500) }; }

    const details = {
      ok: true,
      count: rows.length,
      reportedCount: Number.isFinite(reportedCount) ? reportedCount : null,
      alerts: Number.isFinite(ingest?.alerts) ? ingest.alerts : null,
      checkedAt: now.toISOString(),
    };
    await store.recordHealth("dvc-rental-direct", true, details, null);
    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await store.recordHealth("dvc-rental-direct", false, null, message); } catch { /* keep source failure primary */ }
    return { ok: false, error: message };
  }
}

async function dispatchDvcRentalBrowser(env, now) {
  const store = new Storage(env.DB);
  return withLease(env.DB, "dvc-rental-browser-dispatch", async () => {
  try {
    if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN not configured");

    const response = await boundedFetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${DVC_RENTAL_WORKFLOW}/dispatches`,
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
      throw new Error(`GitHub DVC-Rental workflow dispatch ${response.status}: ${(await response.text()).slice(0, 250)}`);
    }

    const details = { ok: true, dispatchedAt: now.toISOString() };
    await store.recordHealth("dvc-rental-dispatch", true, details, null);
    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await store.recordHealth("dvc-rental-dispatch", false, null, message); } catch { /* keep dispatch failure primary */ }
    return { ok: false, error: message };
  }
  });
}

// If GitHub accepted a dispatch but no completed browser scrape reached D1, retry
// after twelve minutes without ingestion. Never retry faster than five minutes.
async function recoverStaleDvcRentalBrowser(env, now) {
  const store = new Storage(env.DB);
  const health = await store.allHealth();
  const ingest = health.find(row => row.source === "dvc-rental-browser-ingest");
  const dispatch = health.find(row => row.source === "dvc-rental-dispatch");
  const lastIngest = Date.parse(ingest?.lastSuccessAt || "");
  const currentTime = Date.now();
  const lastDispatch = Date.parse(dispatch?.lastCheckedAt || "");
  if (Number.isFinite(lastIngest) && currentTime - lastIngest < 12 * 60000) return { skipped: true, reason: "ingest-fresh" };
  if (Number.isFinite(lastDispatch) && currentTime - lastDispatch < 5 * 60000) return { skipped: true, reason: "recent-dispatch" };
  return dispatchDvcRentalBrowser(env, now);
}


// Mirrors the existing watchdog's overdue policy. Browser dispatch acceptance
// is not evidence of ingestion; the regular browser workflow remains intact.
const RECOVERY_INTERVALS = {
  "dvc-shop": [3, "dvc-shop"],
  "davids": [8, "davids"],
  "rental-store-all": [12, "rental-store-all"],
  "rental-store-website-dispatch": [8, "website-backup-dispatch"],
  "dvcreservations-rare-finds": [15, "rare-finds"],
};

async function recoverOverdueSources(env, now) {
  const store = new Storage(env.DB);
  return withLease(env.DB, "cloudflare-source-recovery", async () => {
    const health = await store.allHealth();
    const recovered = [];
    for (const [source, [expectedMinutes, mode]] of Object.entries(RECOVERY_INTERVALS)) {
      const row = health.find(item => item.source === source);
      const last = Date.parse(row?.lastSuccessAt || "");
      const graceMinutes = source === "dvcreservations-rare-finds" ? 5 : 10;
      if (Number.isFinite(last) && now.getTime() - last < (expectedMinutes + graceMinutes) * 60000) continue;
      try {
        if (mode === "rare-finds") {
          const result = await runRareFinds(env, now);
          if (!result?.ok) throw new Error(`Recovery ${mode} failed: ${JSON.stringify(result).slice(0,350)}`);
          recovered.push(source);
          continue;
        }

        if (!env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN missing");
        const response = await baseWorker.fetch(new Request(`https://dvc-monitor.internal/run?mode=${mode}`, {
          method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
        }), env);
        const result = await response.json();
        if (!response.ok || JSON.stringify(result).includes('"ok":false')) {
          throw new Error(`Recovery ${mode} failed: ${JSON.stringify(result).slice(0,350)}`);
        }
        recovered.push(source);
      } catch (error) {
        console.error("source recovery failed", source, error instanceof Error ? error.message : String(error));
      }
    }
    await store.putMeta("cloudflare-source-recovery", { checkedAt: new Date().toISOString(), recovered });
    return { recovered };
  });
}
