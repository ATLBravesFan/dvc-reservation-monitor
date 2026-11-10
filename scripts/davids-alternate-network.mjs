import { parseDavids } from "../src/parsers.js";

// Executed on GitHub Actions' independent network, only after Cloudflare's
// bounded David's request fails. The Worker re-parses and validates the HTML
// and uses the SAME D1 snapshot, leases, and outbox as the primary watch.
const base = (process.env.DVC_MONITOR_BASE_URL || "").replace(/\/$/, "");
const token = process.env.DVC_MONITOR_INGEST_TOKEN;
if (!base || !token) throw Error("Worker base URL or ingestion token is not configured");
const source = "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent";
const originResponse = await fetch(source, {
  headers: {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/2.0)",
  },
  signal: AbortSignal.timeout(22000),
});
if (!originResponse.ok) throw Error("David's alternate-network HTTP " + originResponse.status);
const html = await originResponse.text();
if (html.length > 2_000_000) throw Error("David's page exceeds safe ingestion limit");
const parsed = parseDavids(html);
if (!parsed.length) throw Error("David's alternate-network parser found no reservations");

let lastStatus = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  const response = await fetch(base + "/ingest/davids-backup", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ html }),
    signal: AbortSignal.timeout(30000),
  });
  lastStatus = response.status;
  if (response.status === 409 && attempt < 3) {
    // Primary Worker may be completing under the same D1 lease. Do not race.
    await new Promise(resolve => setTimeout(resolve, 3000));
    continue;
  }
  if (!response.ok) throw Error("David's backup ingestion HTTP " + response.status);
  const result = await response.json();
  if (!result?.ok || result?.skipped) throw Error("David's backup ingestion did not complete");
  console.log(JSON.stringify({
    ok: true, parsed: parsed.length, ingested: result.count,
    baseline: Boolean(result.baseline),
    queuedAlerts: result.alerts ?? 0,
  }));
  process.exit(0);
}
throw Error("David's backup ingestion remained lease-busy, status " + lastStatus);
