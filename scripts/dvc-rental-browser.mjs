import { chromium } from "playwright-core";
import { parseDvcRentalDealsHtml } from "../src/dvc-rental-direct.js";

const BASE_URL = process.env.DVC_MONITOR_BASE_URL;
const TOKEN = process.env.DVC_MONITOR_INGEST_TOKEN;
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEALS_URL = "https://dvc-rental.com/deals";
const DETAIL_CONCURRENCY = 4;

if (!BASE_URL || !TOKEN) throw new Error("DVC_MONITOR_BASE_URL and DVC_MONITOR_INGEST_TOKEN are required");

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
  const rows = await scrapeDeals(context);
  console.log(`DVC-Rental list: ${rows.length} reservations`);

  // The browser list page can change its visible card layout independently of
  // the structured reservation data. Never ingest a partial card row just
  // because point enrichment succeeded: that previously produced alerts with
  // only ID/resort/points and no dates or prices.
  if (!rows.every(isCompleteReservation)) {
    await enrichPointDetails(context, rows);
  }

  const complete = rows.filter(isCompleteReservation).length;
  const withPoints = rows.filter(row => Number.isFinite(row.points)).length;
  const pointCoverage = rows.length ? withPoints / rows.length : 0;
  console.log(`DVC-Rental complete detail coverage: ${complete}/${rows.length}`);
  console.log(`DVC-Rental point detail coverage: ${withPoints}/${rows.length} (${Math.round(pointCoverage * 100)}%)`);

  if (complete !== rows.length) {
    throw new Error(`DVC-Rental browser detail coverage incomplete: ${complete}/${rows.length}. Snapshot was not ingested.`);
  }
  if (pointCoverage < 0.8) {
    throw new Error(`DVC-Rental point-detail coverage too low: ${withPoints}/${rows.length}. Snapshot was not ingested.`);
  }

  await ingest(rows);
} finally {
  await browser.close();
}

async function scrapeDeals(context) {
  const page = await context.newPage();
  await page.goto(DEALS_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);

  const bodyText = await page.locator("body").innerText();
  const expected = number(
    bodyText.match(/Showing\s+\d+\s*[–-]\s*\d+\s+of\s+(\d+)/i)?.[1] ||
    bodyText.match(/(\d+)\s+confirmed reservations/i)?.[1],
  );

  // Prefer the complete reservation objects embedded in the rendered Next.js
  // document. This keeps the browser fallback independent of visible card
  // markup while preserving every field used in the email: room, dates,
  // nights, total, nightly price, points and point pricing.
  const structured = parseDvcRentalDealsHtml(await page.content());
  if (structured.length) {
    if (Number.isFinite(expected) && structured.length !== expected) {
      await page.close();
      throw new Error(`DVC-Rental structured browser count mismatch: expected ${expected}, parsed ${structured.length}`);
    }
    if (!structured.every(isCompleteReservation)) {
      await page.close();
      throw new Error(`DVC-Rental structured browser data was incomplete: ${structured.filter(isCompleteReservation).length}/${structured.length}`);
    }
    console.log("DVC-Rental browser using complete structured reservation data");
    await page.close();
    return structured;
  }

  // Retain the visible-card parser only as a last-resort discovery path. The
  // completeness gate above ingest prevents these rows from ever generating
  // stripped-down alerts if the site's card markup changes again.
  const pageSize = number(bodyText.match(/Showing\s+\d+\s*[–-]\s*(\d+)\s+of\s+\d+/i)?.[1]) || 50;
  const totalPages = Number.isFinite(expected) ? Math.max(1, Math.ceil(expected / pageSize)) : 2;

  const rows = [];
  rows.push(...await collectPage(page));

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const button = page.getByRole("button", { name: new RegExp(`^${pageNumber}$`) }).last();
    if (!(await button.count())) {
      if (Number.isFinite(expected)) throw new Error(`DVC-Rental pagination button ${pageNumber} was not found`);
      break;
    }
    await button.click();
    await page.waitForTimeout(1400);
    rows.push(...await collectPage(page));
  }

  await page.close();
  const unique = dedupe(rows);
  if (!unique.length) throw new Error("DVC-Rental browser parser returned zero reservations");
  if (Number.isFinite(expected) && unique.length < expected) {
    throw new Error(`DVC-Rental snapshot incomplete: expected ${expected}, parsed ${unique.length}. Snapshot was not ingested.`);
  }
  return unique;
}

async function collectPage(page) {
  const cards = await page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => anchors.map(anchor => ({
    href: anchor.href,
    text: (anchor.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  return cards.map(parseCard).filter(Boolean);
}

function parseCard(card) {
  const text = clean(card.text.replace(/Reduced/gi, " "));
  const id = (text.match(/\b(DVC\d+)\b/i)?.[1] || card.href.match(/\b(DVC\d+)\b/i)?.[1])?.toUpperCase();
  if (!id) return null;

  const idIndex = text.search(/\bDVC\d+\b/i);
  const prefix = clean(text.slice(0, idIndex));
  const [resort, room] = splitRoom(prefix);
  const after = text.slice(idIndex + id.length);
  const total = number(after.match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1]);
  const dates = after.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*(?:→|-|to)\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/i);
  const checkIn = dates ? dateOnly(dates[1]) : null;
  const checkOut = dates ? dateOnly(dates[2]) : null;
  const nights = number(after.match(/(\d+)\s*nights?/i)?.[1]) || diffNights(checkIn, checkOut);

  return {
    id,
    resort,
    room,
    checkIn,
    checkOut,
    nights,
    total,
    nightly: divide(total, nights),
    status: "Available",
    bookingUrl: card.href,
  };
}

async function enrichPointDetails(context, rows) {
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, rows.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= rows.length) return;
      const row = rows[index];

      try {
        const response = await context.request.get(row.bookingUrl, { timeout: 30000 });
        if (!response.ok()) {
          console.warn(`${row.id}: detail HTTP ${response.status()}`);
          continue;
        }

        const text = htmlToText(await response.text());
        const points = number(
          text.match(/\bPoints\s+(\d[\d,]*)\s+points\b/i)?.[1] ||
          text.match(/\b(\d[\d,]*)\s+points\s*[·|]/i)?.[1],
        );
        const listedPointPrice = number(
          text.match(/\bPrice per point\s*\$\s*([\d,.]+)/i)?.[1] ||
          text.match(/\b\$\s*([\d,.]+)\s*\/\s*pt\b/i)?.[1],
        );

        if (Number.isFinite(points)) {
          row.points = points;
          row.effectivePointPrice = divide(row.total, points);
          row.pointPrice = row.effectivePointPrice;
        }
        if (Number.isFinite(listedPointPrice)) row.listedPointPrice = listedPointPrice;
      } catch (error) {
        console.warn(`${row.id}: detail fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  await Promise.all(workers);
}

function isCompleteReservation(row) {
  return Boolean(
    row?.id && row?.resort && row?.room && row?.checkIn && row?.checkOut &&
    Number.isFinite(row?.nights) && Number.isFinite(row?.total) &&
    Number.isFinite(row?.nightly) && Number.isFinite(row?.points)
  );
}

async function ingest(listings) {
  const url = new URL("/ingest/dvc-rental", BASE_URL).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ listings }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`DVC-Rental ingest failed ${response.status}: ${body.slice(0, 500)}`);
  console.log(`DVC-Rental ingest: ${body.slice(0, 1000)}`);
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) if (row?.id) map.set(String(row.id), row);
  return [...map.values()];
}

function splitRoom(value) {
  const text = clean(value);
  const marker = /\b(Tower\s*-\s*(?:Deluxe|Duo)\s+Studio|Deluxe\s+Studio(?:\s+with\s+Walk-In\s+Shower)?|Resort\s+Studio|Tower\s+Studio|Duo\s+Studio|1-Bedroom\s+Villa|2-Bedroom\s+Villa|3-Bedroom\s+Villa|One\s+Bedroom|Two\s+Bedroom|Three\s+Bedroom|Deluxe\s+Inn\s+Room|Grand\s+Villa|Cabin|Bungalow|Treehouse)/i;
  const match = marker.exec(text);
  return match ? [clean(text.slice(0, match.index)), clean(text.slice(match.index))] : [text, ""];
}

function htmlToText(html) {
  return clean(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&middot;|&#183;/gi, "·")
    .replace(/&dollar;|&#36;/gi, "$"));
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function number(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function divide(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b ? a / b : null;
}

function diffNights(a, b) {
  if (!a || !b) return null;
  const nights = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return nights > 0 ? nights : null;
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  const exactIso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (exactIso) return exactIso[1];
  const date = new Date(`${text} 12:00:00 UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
