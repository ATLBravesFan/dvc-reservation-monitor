const originalFetch = globalThis.fetch.bind(globalThis);

const INGEST_PATH = "/ingest/dvc-rental";
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];
const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isDvcRentalIngest(input) {
  try {
    const value = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    return Boolean(value && new URL(value).pathname === INGEST_PATH);
  } catch {
    return false;
  }
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function errorMessage(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `; cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

globalThis.fetch = async function fetchWithDvcRentalIngestRetry(input, init = {}) {
  if (!isDvcRentalIngest(input)) return originalFetch(input, init);

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const attemptNumber = attempt + 1;
    const maxAttempts = RETRY_DELAYS_MS.length + 1;

    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      const response = await originalFetch(input, { ...init, signal });

      if (!isTransientStatus(response.status) || attempt === RETRY_DELAYS_MS.length) {
        return response;
      }

      // Drain the failed response before retrying so the connection can be reused cleanly.
      await response.arrayBuffer().catch(() => {});
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `DVC-Rental ingest transient HTTP ${response.status}; preserving the scraped snapshot and retrying in ` +
        `${delay / 1000}s (attempt ${attemptNumber}/${maxAttempts}).`,
      );
      await sleep(delay);
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new Error(
          `DVC-Rental ingest network request failed after ${maxAttempts} attempts: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `DVC-Rental ingest network failure: ${errorMessage(error)}. Preserving the scraped snapshot and retrying in ` +
        `${delay / 1000}s (attempt ${attemptNumber}/${maxAttempts}).`,
      );
      await sleep(delay);
    }
  }
};
