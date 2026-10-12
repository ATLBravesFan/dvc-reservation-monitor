// Independent safety net for missed Cloudflare cron cycles. No direct alerts:
// all processing goes through the existing D1 leases, snapshots and outbox.
const base = (process.env.DVC_MONITOR_BASE_URL || "").replace(/\/$/, "");
const token = process.env.DVC_MONITOR_ADMIN_TOKEN;
if (!base || !token) throw Error("Monitor URL or admin token missing");
const response = await fetch(base + "/health", { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw Error("Health HTTP " + response.status);
const health = (await response.json()).health || [];
const now = Date.now();
const watches = [
  { source: "rental-store-api", mode: "rental-store", staleMinutes: 4 },
  { source: "dvc-shop", mode: "dvc-shop", staleMinutes: 4 },
  { source: "davids", mode: "davids", staleMinutes: 9 },
];
let failures = 0;
await Promise.all(watches.map(async ({ source, mode, staleMinutes }) => {
  const row = health.find(x => x.source === source);
  const last = Date.parse(row?.lastSuccessAt || "");
  if (Number.isFinite(last) && now - last < staleMinutes * 60000) {
    console.log("FRESH", source, row.lastSuccessAt);
    return;
  }
  console.log("OVERDUE", source, "last success", row?.lastSuccessAt || "never");
  try {
    const result = await fetch(base + "/run?mode=" + encodeURIComponent(mode), {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(45000),
    });
    if (!result.ok) throw Error("HTTP " + result.status);
    const body = await result.json();
    const value = body[Object.keys(body)[0]];
    if (value?.skipped) {
      console.log("LEASE BUSY", source, "will retry next cycle");
      return;
    }
    if (value?.ok === false || value?.error) throw Error(JSON.stringify(value).slice(0, 300));
    console.log("RECOVERY REQUEST COMPLETED", source);
  } catch (error) {
    failures++;
    console.error("RECOVERY FAILED", source, String(error));
  }
}));
if (failures) process.exitCode = 1;
