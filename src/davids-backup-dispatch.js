import { boundedFetch } from "./bounded-fetch.js";
import { Storage } from "./storage.js";
import { withLease } from "./execution-lease.js";

const WORKFLOW = "davids-alternate-network.yml";
const REPOSITORY = "ATLBravesFan/dvc-reservation-monitor";
const COOLDOWN_MS = 4 * 60 * 1000;

// Pure function for regression tests and for avoiding duplicate GH dispatches
// from scheduled checks, recovery, or overlapping Worker invocations.
export function shouldDispatchDavidsBackup(lastDispatchAt, now = new Date()) {
  const previous = Date.parse(lastDispatchAt || "");
  return !Number.isFinite(previous) ||
    now.getTime() - previous >= COOLDOWN_MS;
}

export async function dispatchDavidsBackup(env, now = new Date()) {
  const store = new Storage(env.DB);
  return withLease(env.DB, "davids-alternate-dispatch-lease", async () => {
    const health = await store.allHealth();
    const previous = health.find(row => row.source === "davids-alternate-dispatch");
    if (previous?.ok && !shouldDispatchDavidsBackup(previous.lastSuccessAt, now)) {
      return { skipped: true, reason: "recent-dispatch" };
    }
    try {
      if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN not configured");
      const response = await boundedFetch(
        "https://api.github.com/repos/" + REPOSITORY + "/actions/workflows/" + WORKFLOW + "/dispatches",
        {
          timeoutMs: 12000,
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DVC-Reservation-Monitor",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      if (response.status !== 204) {
        throw new Error("David's backup dispatch HTTP " + response.status);
      }
      await store.recordHealth("davids-alternate-dispatch", true, { dispatchedAt: now.toISOString() }, null);
      return { ok: true, dispatchedAt: now.toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await store.recordHealth("davids-alternate-dispatch", false, null, message); }
      catch { /* Preserve original dispatch error. */ }
      throw error;
    }
  });
}
