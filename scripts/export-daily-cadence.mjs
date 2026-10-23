// Export only aggregate, authenticated D1 diagnostics. No reservation inventory,
// customer details, admin tokens or email addresses belong in job logs/artifacts.
import { appendFileSync, writeFileSync } from "node:fs";

const base = (process.env.DVC_MONITOR_BASE_URL || "").replace(/\/$/, "");
const token = process.env.DVC_MONITOR_ADMIN_TOKEN;
const requestedDay = (process.env.DVC_AUDIT_DAY || "").trim();
if (!base || !token) throw Error("Missing DVC_MONITOR_BASE_URL or DVC_MONITOR_ADMIN_TOKEN");
if (requestedDay && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDay)) {
  throw Error("DVC_AUDIT_DAY must be YYYY-MM-DD");
}

const url = new URL(base + "/diagnostics/daily-cadence");
if (requestedDay) url.searchParams.set("day", requestedDay);
const response = await fetch(url, {
  headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw Error("Authenticated D1 cadence endpoint returned HTTP " + response.status);
const report = await response.json();
if (!report || !Array.isArray(report.watches) || !report.day ||
    report.sourceOfTruth !== "Cloudflare D1 execution_history") {
  throw Error("D1 cadence endpoint returned an invalid/incomplete report");
}
if (requestedDay && report.day !== requestedDay) throw Error("D1 cadence day mismatch");
const output = JSON.stringify(report, null, 2) + "\n";
writeFileSync("daily-d1-cadence.json", output, { mode: 0o600 });

const summary = [
  "# DVC verified Cloudflare D1 cadence — " + report.day,
  "",
  "Source: authenticated Cloudflare D1 execution_history; " +
  report.windowStart + " to " + report.windowEndExclusive + " (end exclusive).",
  "",
  "| Watch | Target | Successes | Failures | Avg gap | Longest gap | Late gaps | Status |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
];
for (const row of report.watches) {
  const value = x => x === null || x === undefined ? "—" : String(x);
  summary.push("| " + row.label + " | " + row.configuredMinutes + "m | " +
    row.successfulRuns + " | " + row.failedRuns + " | " +
    value(row.averageMinutes) + "m | " + value(row.longestGapMinutes) +
    "m | " + row.gapsAtLeast10MinutesLate + " | " + row.status + " |");
  if (["behind", "no-executions", "no-successes"].includes(row.status)) {
    console.log("::warning title=DVC watch requires review::" + row.label +
      " — " + row.status + ". " + row.nextAction);
  }
}
summary.push("", "GitHub workflow successes alone do not establish ingestion or email delivery.",
  "Blank averages mean insufficient consecutive successes, not a measured zero.");
const markdown = summary.join("\n") + "\n";
console.log(markdown);
console.log("DVC_D1_CADENCE_REPORT_BEGIN");
console.log(JSON.stringify(report));
console.log("DVC_D1_CADENCE_REPORT_END");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
