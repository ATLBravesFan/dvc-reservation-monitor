import { chromium } from "playwright-core";
import { parseDvcRentalDealsHtml } from "../src/dvc-rental-direct.js";

const DEALS_URL = "https://dvc-rental.com/deals";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const ITERATIONS = Number(process.env.COMPARE_ITERATIONS || 3);
const DETAIL_CONCURRENCY = 6;

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

let failed = false;
try {
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    console.log(`\n===== DVC-RENTAL COMPARISON ${iteration}/${ITERATIONS} =====`);
    try {
      await compareOnce(context);
    } catch (error) {
      failed = true;
      console.error(`Comparison ${iteration} FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
    if (iteration < ITERATIONS) await sleep(8000);
  }
} finally {
  await browser.close();
}

if (failed) process.exitCode = 1;

async function compareOnce(context) {
  const rawResponse = await fetch(DEALS_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    },
  });
  if (!rawResponse.ok) throw new Error(`Raw fetch HTTP ${rawResponse.status}`);
  const html = await rawResponse.text();
  const direct = parseDvcRentalDealsHtml(html);
  if (!direct.length) throw new Error("Direct parser returned zero reservations");
  const directById = new Map(direct.map(row => [row.id, row]));

  const rawIds = new Set([...html.matchAll(/\bDVC\d+\b/gi)].map(m => m[0].toUpperCase()));
  console.log(`Raw HTML IDs: ${rawIds.size}; direct parsed rows: ${direct.length}`);
  compareSets("raw HTML vs direct parser", rawIds, new Set(directById.keys()));

  const page = await context.newPage();
  let browserRows;
  try {
    await page.goto(DEALS_URL, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);
    browserRows = await collectAllBrowserRows(page);
  } finally {
    await page.close();
  }

  const browserById = new Map(browserRows.map(row => [row.id, row]));
  console.log(`Browser-rendered rows: ${browserRows.length}`);
  compareSets("browser vs direct parser", new Set(browserById.keys()), new Set(directById.keys()));

  const fieldMismatches = [];
  for (const [id, directRow] of directById) {
    const browserRow = browserById.get(id);
    if (!browserRow) continue;
    compareField(fieldMismatches, id, "checkIn", directRow.checkIn, browserRow.checkIn);
    compareField(fieldMismatches, id, "checkOut", directRow.checkOut, browserRow.checkOut);
    compareNumber(fieldMismatches, id, "nights", directRow.nights, browserRow.nights, 0);
    compareNumber(fieldMismatches, id, "total", directRow.total, browserRow.total, 1.01);
  }
  if (fieldMismatches.length) {
    console.error("Browser/direct core-field mismatches:");
    for (const line of fieldMismatches.slice(0, 30)) console.error(`  ${line}`);
    throw new Error(`${fieldMismatches.length} browser/direct core-field mismatch(es)`);
  }
  console.log("Browser/direct IDs, dates, nights, and listed totals match.");

  const detailMismatches = [];
  let next = 0;
  const rows = [...directById.values()];
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, rows.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const response = await context.request.get(row.bookingUrl, { timeout: 30000 });
        if (!response.ok()) {
          detailMismatches.push(`${row.id} detail HTTP ${response.status()}`);
          continue;
        }
        const text = htmlToText(await response.text());
        const detailPoints = number(
          text.match(/\bPoints\s+(\d[\d,]*)\s+points\b/i)?.[1] ||
          text.match(/\b(\d[\d,]*)\s+points\s*[·|]/i)?.[1],
        );
        const detailListed = number(
          text.match(/\bPrice per point\s*\$\s*([\d,.]+)/i)?.[1] ||
          text.match(/\b\$\s*([\d,.]+)\s*\/\s*pt\b/i)?.[1],
        );
        if (Number.isFinite(detailPoints) && Number.isFinite(row.points) && detailPoints !== row.points) {
          detailMismatches.push(`${row.id} points direct=${row.points} detail=${detailPoints}`);
        }
        if (Number.isFinite(detailListed) && Number.isFinite(row.listedPointPrice) && Math.abs(detailListed - row.listedPointPrice) > 0.01) {
          detailMismatches.push(`${row.id} listed $/pt direct=${row.listedPointPrice} detail=${detailListed}`);
        }
      } catch (error) {
        detailMismatches.push(`${row.id} detail error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);

  if (detailMismatches.length) {
    console.error("Direct/detail mismatches or fetch failures:");
    for (const line of detailMismatches.slice(0, 30)) console.error(`  ${line}`);
    throw new Error(`${detailMismatches.length} detail mismatch/failure(s)`);
  }
  console.log(`All ${rows.length} direct rows matched their detail-page points and listed $/point when exposed.`);
  console.log("COMPARISON PASSED");
}

async function collectAllBrowserRows(page) {
  const bodyText = await page.locator("body").innerText();
  const expected = number(
    bodyText.match(/Showing\s+\d+\s*[–-]\s*\d+\s+of\s+(\d+)/i)?.[1] ||
    bodyText.match(/(\d+)\s+confirmed reservations/i)?.[1],
  );
  const pageSize = number(bodyText.match(/Showing\s+\d+\s*[–-]\s*(\d+)\s+of\s+\d+/i)?.[1]) || 50;
  const totalPages = Number.isFinite(expected) ? Math.max(1, Math.ceil(expected / pageSize)) : 2;
  const rows = [];
  rows.push(...await collectVisibleCards(page));

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const button = page.getByRole("button", { name: new RegExp(`^${pageNumber}$`) }).last();
    if (!(await button.count())) throw new Error(`Browser pagination button ${pageNumber} missing`);
    await button.click();
    await page.waitForTimeout(900);
    rows.push(...await collectVisibleCards(page));
  }

  const map = new Map();
  for (const row of rows) if (row?.id) map.set(row.id, row);
  const unique = [...map.values()];
  if (Number.isFinite(expected) && unique.length !== expected) {
    throw new Error(`Browser expected ${expected} reservations but collected ${unique.length}`);
  }
  return unique;
}

async function collectVisibleCards(page) {
  const cards = await page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => anchors
    .filter(anchor => {
      const style = getComputedStyle(anchor);
      const rect = anchor.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map(anchor => ({ href: anchor.href, text: (anchor.innerText || "").replace(/\s+/g, " ").trim() })));
  return cards.map(parseCard).filter(Boolean);
}

function parseCard(card) {
  const text = clean(card.text.replace(/Reduced/gi, " "));
  const id = (text.match(/\b(DVC\d+)\b/i)?.[1] || card.href.match(/\b(DVC\d+)\b/i)?.[1])?.toUpperCase();
  if (!id) return null;
  const idIndex = text.search(/\bDVC\d+\b/i);
  const after = text.slice(idIndex + id.length);
  const total = number(after.match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1]);
  const dates = after.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*(?:→|-|to)\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/i);
  const checkIn = dates ? dateOnly(dates[1]) : null;
  const checkOut = dates ? dateOnly(dates[2]) : null;
  const nights = number(after.match(/(\d+)\s*nights?/i)?.[1]) || diffNights(checkIn, checkOut);
  return { id, total, checkIn, checkOut, nights };
}

function compareSets(label, expected, actual) {
  const missing = [...expected].filter(id => !actual.has(id));
  const extra = [...actual].filter(id => !expected.has(id));
  if (missing.length || extra.length) {
    console.error(`${label}: missing=${missing.length}, extra=${extra.length}`);
    if (missing.length) console.error(`  Missing sample: ${missing.slice(0, 20).join(", ")}`);
    if (extra.length) console.error(`  Extra sample: ${extra.slice(0, 20).join(", ")}`);
    throw new Error(`${label} ID-set mismatch`);
  }
  console.log(`${label}: exact ID-set match (${actual.size})`);
}

function compareField(out, id, field, a, b) {
  if ((a ?? null) !== (b ?? null)) out.push(`${id} ${field}: direct=${a} browser=${b}`);
}
function compareNumber(out, id, field, a, b, tolerance) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (!(a == null && b == null)) out.push(`${id} ${field}: direct=${a} browser=${b}`);
    return;
  }
  if (Math.abs(a - b) > tolerance) out.push(`${id} ${field}: direct=${a} browser=${b}`);
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
function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function number(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function diffNights(a, b) {
  if (!a || !b) return null;
  const nights = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return nights > 0 ? nights : null;
}
function dateOnly(value) {
  const date = new Date(`${String(value).trim()} 12:00:00 UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
