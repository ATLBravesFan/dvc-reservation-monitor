import { parseDavids } from "../src/parsers.js";

// Read-only alternate-network probe from GitHub's runner. Do not ingest,
// change snapshots, send emails, or expose raw HTML.
const variants = [
  ["configured URL", "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent/"],
  ["canonical URL", "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent"],
];
for (const [label, url] of variants) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor/2.0)",
      },
      signal: AbortSignal.timeout(20000),
    });
    const html = await response.text();
    const reservations = response.ok ? parseDavids(html).length : 0;
    console.log(JSON.stringify({
      label, responseStatus: response.status,
      followedRedirect: response.url !== url,
      durationMs: Date.now() - start,
      responseBytes: html.length,
      parsedReservations: reservations,
      valid: response.ok && reservations > 0,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      label, elapsedMs: Date.now() - start,
      errorType: error?.name || "fetch-error",
    }));
  }
}
