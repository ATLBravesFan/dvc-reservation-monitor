// David's site intermittently returns Cloudflare 522 and stalls while rendering.
// Give only this source one short retry; the five-minute schedule stays unchanged.
export const DAVIDS_FIRST_TIMEOUT_MS = 30000;
export const DAVIDS_RETRY_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 700;
const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const WARNING_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HEALTHY_CHECK_SPACING_MS = 4 * 60 * 1000;
const HEALTHY_WINDOW_MS = 9 * 60 * 1000;

export function isTransientDavidsFailure(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400) return RETRYABLE_STATUSES.has(status);
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP timeout after|fetch failed|failed to fetch|network error|connection reset|ECONNRESET|ETIMEDOUT|socket hang up|operation was aborted|AbortError/i.test(message);
}

export async function withDavidsRetry(fetchPage, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  try {
    return await fetchPage(DAVIDS_FIRST_TIMEOUT_MS);
  } catch (error) {
    if (!isTransientDavidsFailure(error)) throw error;
    await sleep(RETRY_DELAY_MS);
    return fetchPage(DAVIDS_RETRY_TIMEOUT_MS);
  }
}

// A warning is one incident, not a new incident after every brief successful poll.
// Recovery requires three successful polls spread over at least nine minutes.
// A six-hour warning cooldown also prevents repeated alerts during flapping.
export function nextDavidsIncident(previous, { ok, consecutiveFailures = 0, at }) {
  const when = Date.parse(at);
  if (!Number.isFinite(when)) throw new Error("David's incident transition requires a valid timestamp");
  const state = previous && typeof previous === "object" ? previous : null;
  const unchanged = () => ({ state, changed: false, notification: null });

  if (ok) {
    if (!state?.active) return unchanged();
    const lastGood = Date.parse(state.lastGoodAt || "");
    if (Number(state.goodChecks || 0) > 0 && Number.isFinite(lastGood) && when - lastGood < HEALTHY_CHECK_SPACING_MS) {
      return unchanged();
    }
    const goodChecks = Number(state.goodChecks || 0) + 1;
    const firstGoodAt = state.goodChecks ? state.firstGoodAt : at;
    if (goodChecks >= 3 && when - Date.parse(firstGoodAt) >= HEALTHY_WINDOW_MS) {
      return {
        state: { ...state, active: false, recoveredAt: at, goodChecks: 0, firstGoodAt: null, lastGoodAt: null },
        changed: true, notification: "recovery",
      };
    }
    return {
      state: { ...state, goodChecks, firstGoodAt, lastGoodAt: at },
      changed: true, notification: null,
    };
  }

  if (state?.active) {
    if (!state.goodChecks) return unchanged();
    return {
      state: { ...state, goodChecks: 0, firstGoodAt: null, lastGoodAt: null },
      changed: true, notification: null,
    };
  }
  if (consecutiveFailures < 3) return unchanged();

  // Existing production incidents already emitted a warning at failure #3
  // before this state machine was deployed. Adopt them without resending.
  if (!state && consecutiveFailures > 3) {
    return {
      state: { active: true, openedAt: at, lastWarningAt: at, goodChecks: 0, firstGoodAt: null, lastGoodAt: null },
      changed: true, notification: null,
    };
  }

  const lastWarning = Date.parse(state?.lastWarningAt || "");
  if (Number.isFinite(lastWarning) && when - lastWarning < WARNING_COOLDOWN_MS) return unchanged();
  return {
    state: { ...state, active: true, openedAt: at, lastWarningAt: at, goodChecks: 0, firstGoodAt: null, lastGoodAt: null },
    changed: true, notification: "warning",
  };
}
