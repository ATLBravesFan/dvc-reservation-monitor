// One-time, read-only David's execution-history diagnosis using the existing
// Cloudflare API token. Never print credentials, reservation payloads or raw
// upstream errors into public GitHub Actions logs.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw Error("Cloudflare read credentials missing");
const apiRoot = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function api(path, options = {}) {
  const response = await fetch(apiRoot + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(35000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw Error("Cloudflare API query failed: HTTP " + response.status +
      " codes " + (payload.errors || []).map(e => e.code).join(","));
  }
  return payload.result;
}
const databases = await api("/d1/database?name=dvc-monitor-state&per_page=100&page=1");
const matches = (databases || []).filter(db => db.name === "dvc-monitor-state");
if (matches.length !== 1 || !matches[0].uuid) throw Error("Unable to locate one DVC D1 database");

const query = await api("/d1/database/" + matches[0].uuid + "/query", {
  method: "POST",
  body: JSON.stringify({
    sql: "SELECT started_at,outcome,error FROM execution_history " +
      "WHERE source='davids' AND julianday(started_at) >= julianday(?) " +
      "ORDER BY started_at ASC LIMIT 1500",
    params: ["2026-11-07T00:00:00.000Z"],
  }),
});
const rows = query?.[0]?.results;
if (!Array.isArray(rows)) throw Error("D1 did not return diagnostic rows");
const newRetryDeployed = "2026-11-09T18:40:32Z";
function classify(message) {
  if (!message) return "none";
  const s = String(message);
  const status = s.match(/(?:^|[^\d])(4\d\d|5\d\d)(?:[^\d]|$)/);
  if (status) return "HTTP " + status[1];
  const elapsed = /HTTP timeout after (\\d+)ms/i.exec(s);
  if (elapsed) return "timeout " + elapsed[1] + "ms";
  if (/timeout|aborted|AbortError/i.test(s)) return "timeout";
  if (/fetch failed|network error|ECONNRESET|socket hang up/i.test(s)) return "network";
  if (/parser|zero reservations|parse/i.test(s)) return "parser/empty inventory";
  if (/inventory|collapse|snapshot|duplicate/i.test(s)) return "inventory guard";
  if (/database|D1|SQLITE|storage/i.test(s)) return "D1/storage";
  if (/alert|email|brevo|outbox/i.test(s)) return "alert processing";
  return "unclassified";
}
const counts = new Map();
const recentFailures = [];
for (const row of rows) {
  const phase = Date.parse(row.started_at) >= Date.parse(newRetryDeployed)
    ? "after-retry-deploy" : "before-retry-deploy";
  const key = [phase, row.outcome, row.outcome === "failure" ? classify(row.error) : "none"].join("|");
  const prior = counts.get(key) || { phase, outcome: row.outcome,
    errorType: row.outcome === "failure" ? classify(row.error) : "none",
    count: 0, first: row.started_at, last: row.started_at };
  prior.count++;
  prior.last = row.started_at;
  counts.set(key, prior);
  if (row.outcome === "failure") recentFailures.push({
    at: row.started_at, phase, cause: classify(row.error),
  });
}
const result = {
  asOf: new Date().toISOString(),
  deployedAt: newRetryDeployed,
  windowStart: "2026-11-07T00:00:00.000Z",
  source: "Cloudflare D1 execution_history",
  totalRows: rows.length,
  groups: [...counts.values()].sort((a,b) => a.phase.localeCompare(b.phase) || a.outcome.localeCompare(b.outcome)),
  lastFailures: recentFailures.slice(-30),
  note: "Error types are deliberately sanitized; successful executions are not proof of delivery.",
};
console.log("DAVIDS_D1_DIAGNOSIS_BEGIN");
console.log(JSON.stringify(result));
console.log("DAVIDS_D1_DIAGNOSIS_END");
