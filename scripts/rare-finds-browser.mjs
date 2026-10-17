import { chromium } from "playwright-core";
import { parseRareFinds } from "../src/rare-finds.js";

const BASE_URL = process.env.DVC_MONITOR_BASE_URL;
const TOKEN = process.env.DVC_MONITOR_INGEST_TOKEN;
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const RARE_FINDS_URL = "https://dvcreservations.com/rarefindslist.php";
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 120000;
const INGEST_ATTEMPTS = 8;
const INGEST_RETRY_DELAY_MS = 15000;

if (!BASE_URL || !TOKEN) {
  throw new Error("DVC_MONITOR_BASE_URL and DVC_MONITOR_INGEST_TOKEN are required");
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-US",
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

try {
  const { html, checkedAt, count } = await fetchRareFindsWithBackoff(context);
  console.log(`DVCReservations Rare Finds browser parsed ${count} reservations.`);
  await ingestHtml(html, checkedAt);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Rare Finds browser backup failed: ${message}`);
  await reportFailure(message);
  throw error;
} finally {
  await browser.close();
}

async function fetchRareFindsWithBackoff(browserContext) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const page = await browserContext.newPage();
    try {
      const response = await page.goto(RARE_FINDS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (!response) throw new Error("Rare Finds browser returned no HTTP response");
      if (!response.ok()) throw new Error(`DVCReservations Rare Finds browser HTTP ${response.status()}`);
      await page.waitForTimeout(1000);
      const html = await page.content();
      const checkedAt = new Date().toISOString();
      const rows = parseRareFinds(html, new Date(checkedAt));
      if (!rows.length) throw new Error("DVCReservations Rare Finds browser parser returned zero reservations");
      return { html, checkedAt, count: rows.length };
    } catch (error) {
      lastError = error;
      console.warn(`Rare Finds browser attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await page.close();
    }

    if (attempt < FETCH_ATTEMPTS) {
      console.log(`Waiting ${FETCH_RETRY_DELAY_MS / 1000}s before the next Rare Finds browser attempt.`);
      await sleep(FETCH_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error("DVCReservations Rare Finds browser request failed");
}

async function ingestHtml(html, checkedAt) {
  const url = new URL("/ingest/rare-finds", BASE_URL).toString();
  for (let attempt = 1; attempt <= INGEST_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ html, checkedAt }),
    });
    const body = await response.text();
    if (response.ok) {
      console.log(`Rare Finds browser ingest: ${body.slice(0, 1000)}`);
      return;
    }

    const leaseBusy = response.status === 409 && /already-running/i.test(body);
    if (!leaseBusy || attempt === INGEST_ATTEMPTS) {
      throw new Error(`Rare Finds browser ingest failed ${response.status}: ${body.slice(0, 500)}`);
    }

    console.warn(`Rare Finds ingest lease busy; retrying in ${INGEST_RETRY_DELAY_MS / 1000}s (${attempt}/${INGEST_ATTEMPTS}).`);
    await sleep(INGEST_RETRY_DELAY_MS);
  }
}

async function reportFailure(message) {
  const url = new URL("/ingest/rare-finds/failure", BASE_URL).toString();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: message }),
      });
      if (response.ok) {
        console.log(`Rare Finds failure reported: ${(await response.text()).slice(0, 1000)}`);
        return;
      }
      lastError = new Error(`failure report HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await sleep(15000);
  }
  console.error(`Could not report Rare Finds browser failure: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
