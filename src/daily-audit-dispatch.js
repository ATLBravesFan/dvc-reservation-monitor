import { boundedFetch } from "./bounded-fetch.js";
import { nyDay, adjacentDay } from "./daily-cadence-report.js";
import { withLease } from "./execution-lease.js";
import { Storage } from "./storage.js";

const WORKFLOW = "daily-d1-cadence-audit.yml";
const REPOSITORY = "ATLBravesFan/dvc-reservation-monitor";

// Dispatch the authenticated D1 audit from Cloudflare rather than trusting
// delayed GitHub cron schedules. The GitHub cron remains a secondary fallback.
export async function dispatchDailyCadenceAudit(env, now = new Date()) {
  const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
    minute: "2-digit",
  }).formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const hour = Number(localParts.hour), minute = Number(localParts.minute);
  if (hour !== 8 || minute < 20 || minute > 55 || minute % 5 !== 0) {
    return { skipped: true, reason: "outside-daily-window" };
  }

  const day = adjacentDay(nyDay(now), -1);
  const store = new Storage(env.DB);
  const metaKey = "daily-cadence-audit-dispatched:" + day;
  if (await store.getMeta(metaKey)) return { skipped: true, reason: "already-dispatched", day };

  try {
    return await withLease(env.DB, "daily-cadence-audit-dispatch", async () => {
      // Double-check while holding the lease, for overlapping scheduled ticks.
      if (await store.getMeta(metaKey)) return { skipped: true, reason: "already-dispatched", day };
      if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN is missing");
      const response = await boundedFetch(
        "https://api.github.com/repos/" + REPOSITORY +
        "/actions/workflows/" + WORKFLOW + "/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DVC-Reservation-Monitor",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main", inputs: { day } }),
        },
      );
      if (response.status !== 204) {
        throw new Error("Daily cadence workflow dispatch HTTP " + response.status +
          ": " + (await response.text()).slice(0, 250));
      }
      await store.putMeta(metaKey, { day, dispatchedAt: new Date().toISOString() });
      await store.recordHealth("daily-cadence-audit-dispatch", true, { day }, null);
      return { ok: true, day };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.recordHealth("daily-cadence-audit-dispatch", false, null, message);
    throw error;
  }
}
