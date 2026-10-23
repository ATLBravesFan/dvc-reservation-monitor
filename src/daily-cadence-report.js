// Read-only D1 execution cadence for a complete America/New_York calendar day.
// Do not mistake inaccessible D1 history for zero runs: endpoint errors propagate.
const WATCHES = [
  ["rental-store-api", 1, "Rental Store API (bargain checks)"],
  ["rental-store-all", 10, "Rental Store all listings"],
  ["rental-store-website", 5, "Rental Store website ingestion"],
  ["rental-store-website-dispatch", 5, "Rental Store website dispatcher"],
  ["davids", 5, "David's"],
  ["dvc-shop", 5, "DVC Shop"],
  ["dvc-rental", 5, "DVC-Rental ingestion (direct and browser)"],
  ["dvcreservations-rare-finds", 15, "Rare Finds"],
  ["alert-outbox-drain", 1, "Alert outbox"],
  ["cloudflare-source-recovery", 5, "Cloudflare source recovery"],
];
const NY = "America/New_York";

export function nyDay(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return p.year + "-" + p.month + "-" + p.day;
}

export function adjacentDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta, 12)).toISOString().slice(0, 10);
}

export function utcBoundary(day) {
  const [y, m, d] = day.split("-").map(Number);
  // 05:00 UTC is midnight or 01:00 in New York, including both DST change
  // nights. Noon uses the WRONG offset for midnight on a DST transition day.
  const early = new Date(Date.UTC(y, m - 1, d, 5));
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, timeZoneName: "shortOffset",
  }).formatToParts(early).find(x => x.type === "timeZoneName")?.value;
  const offset = zone?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!offset) throw new Error("Cannot resolve New York UTC offset");
  const minutes = (offset[1] === "+" ? 1 : -1) *
    (Number(offset[2]) * 60 + Number(offset[3] || 0));
  return new Date(Date.UTC(y, m - 1, d) - minutes * 60000);
}

export async function dailyCadenceReport(db, requestedDay = null, now = new Date()) {
  const today = nyDay(now);
  const day = requestedDay || adjacentDay(today, -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      new Date(day + "T12:00:00Z").toISOString().slice(0, 10) !== day ||
      nyDay(utcBoundary(day)) !== day || day >= today) {
    throw new Error("day must be a valid completed America/New_York date (YYYY-MM-DD)");
  }
  const start = utcBoundary(day), end = utcBoundary(adjacentDay(day, 1));

  // julianday handles ISO-8601 timestamps with T/Z consistently. Do not compare
  // them lexicographically to SQLite datetime('now') values containing spaces.
  const result = await db.prepare(
    "SELECT source, started_at, outcome FROM execution_history " +
    "WHERE julianday(started_at) >= julianday(?) " +
    "AND julianday(started_at) < julianday(?) ORDER BY source, started_at"
  ).bind(start.toISOString(), end.toISOString()).all();
  if (!Array.isArray(result?.results)) throw new Error("D1 did not return execution history");

  const bySource = new Map();
  for (const row of result.results) {
    if (!bySource.has(row.source)) bySource.set(row.source, []);
    bySource.get(row.source).push(row);
  }

  const watches = WATCHES.map(([source, configuredMinutes, label]) => {
    const executions = bySource.get(source) || [];
    const times = executions.filter(r => r.outcome === "success")
      .map(r => Date.parse(r.started_at)).filter(Number.isFinite);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / 60000)
      .filter(g => Number.isFinite(g) && g >= 0);
    const average = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    const longest = gaps.length ? Math.max(...gaps) : null;
    const lateGaps = gaps.filter(g => g >= configuredMinutes + 10).length;
    const failures = executions.filter(r => r.outcome === "failure").length;
    const interruptions = executions.filter(r => r.outcome === "interrupted").length;
    const status = !executions.length ? "no-executions" :
      !times.length ? "no-successes" :
      times.length < 2 ? "insufficient-samples" :
      average >= configuredMinutes + 10 || lateGaps >= 2 ? "behind" : "within-threshold";
    const nextAction = status === "behind" ?
      "Inspect scheduled ticks, failed checks, D1 leases and upstream availability" :
      status === "no-successes" || status === "no-executions" ?
      "Verify Worker scheduling, D1 history recording and source health immediately" :
      status === "insufficient-samples" ?
      "Verify polling and execution history; one success cannot establish cadence" :
      failures || interruptions ? "Inspect failures/interrupted runs for repeat patterns" :
      "No action indicated by successful-run cadence";
    return {
      source, label, configuredMinutes,
      totalExecutions: executions.length, successfulRuns: times.length,
      failedRuns: failures, interruptedRuns: interruptions,
      averageMinutes: average === null ? null : Number(average.toFixed(2)),
      longestGapMinutes: longest === null ? null : Number(longest.toFixed(2)),
      gapsAtLeast10MinutesLate: lateGaps,
      status, nextAction,
    };
  });

  return {
    day, timeZone: NY, windowStart: start.toISOString(),
    windowEndExclusive: end.toISOString(),
    hoursInCalendarDay: (end - start) / 3600000,
    measurement: "Elapsed minutes between consecutive successful execution start times",
    sourceOfTruth: "Cloudflare D1 execution_history",
    limitations: [
      "A GitHub browser workflow success does not prove that website ingestion succeeded.",
      "Browser dispatch acceptance and browser ingestion are separate; only actual D1 executions are counted.",
      "Success cadence is not website publication-to-email latency.",
      "A zero here means the authenticated D1 query succeeded but returned no matching successes or executions, not that D1 was inaccessible.",
      "A single unusually long gap is reported but only recurring late gaps or a slow average trigger the behind flag.",
    ],
    watches,
  };
}
