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

try {
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    console.log(`\n===== DVC-RENTAL VALIDATION ${iteration}/${ITERATIONS} =====`);
    await validateOnce(context);
    if (iteration < ITERATIONS) await sleep(8000);
  }
  console.log(`\nALL ${ITERATIONS} DVC-RENTAL VALIDATIONS PASSED`);
} finally {
  await browser.close();
}

async function validateOnce(context) {
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

  const directIds = new Set(direct.map(row => row.id));
  const rawIds = new Set([...html.matchAll(/\bDVC\d+\b/gi)].map(m => m[0].toUpperCase()));
  compareSets("raw source vs structured parser", rawIds, directIds);

  const incomplete = direct.filter(row => !row.id || !row.checkIn || !row.checkOut || !Number.isFinite(row.nights) || !Number.isFinite(row.total) || !Number.isFinite(row.points));
  if (incomplete.length) throw new Error(`Direct parser has ${incomplete.length}/${direct.length} incomplete row(s): ${incomplete.slice(0, 8).map(r => r.id).join(", ")}`);
  console.log(`Direct parser completeness: ${direct.length}/${direct.length} rows have ID/dates/nights/total/points`);

  const page = await context.newPage();
  let browserIds;
  let browserExpected;
  try {
    await page.goto(DEALS_URL, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200);
    const bodyText = await page.locator("body").innerText();
    browserExpected = number(
      bodyText.match(/Showing\s+\d+\s*[–-]\s*\d+\s+of\s+(\d+)/i)?.[1] ||
      bodyText.match(/(\d+)\s+confirmed reservations/i)?.[1],
    );
    const pageSize = number(bodyText.match(/Showing\s+\d+\s*[–-]\s*(\d+)\s+of\s+\d+/i)?.[1]) || 50;
    const totalPages = Number.isFinite(browserExpected) ? Math.max(1, Math.ceil(browserExpected / pageSize)) : 2;
    browserIds = new Set(await idsOnPage(page));
    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
      const button = page.getByRole("button", { name: new RegExp(`^${pageNumber}$`) }).last();
      if (!(await button.count())) throw new Error(`Browser pagination button ${pageNumber} missing`);
      await button.click();
      await page.waitForTimeout(900);
      for (const id of await idsOnPage(page)) browserIds.add(id);
    }
  } finally {
    await page.close();
  }

  if (Number.isFinite(browserExpected) && browserIds.size !== browserExpected) {
    throw new Error(`Browser reports ${browserExpected} reservations but rendered pages yielded ${browserIds.size} unique IDs`);
  }
  compareSets("browser-rendered inventory vs direct parser", browserIds, directIds);

  const detailErrors = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, direct.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= direct.length) return;
      const row = direct[index];
      try {
        const response = await context.request.get(row.bookingUrl, { timeout: 30000 });
        if (!response.ok()) {
          detailErrors.push(`${row.id}: detail HTTP ${response.status()}`);
          continue;
        }
        const text = htmlToText(await response.text());
        const detailPoints = number(
          text.match(/\bPoints\s+(\d[\d,]*)\s+points\b/i)?.[1] ||
          text.match(/\b(\d[\d,]*)\s+points\s*[·|]/i)?.[1],
        );
        const detailListedPointPrice = number(
          text.match(/\bPrice per point\s*\$\s*([\d,.]+)/i)?.[1] ||
          text.match(/\b\$\s*([\d,.]+)\s*\/\s*pt\b/i)?.[1],
        );
        if (!Number.isFinite(detailPoints)) detailErrors.push(`${row.id}: detail page did not expose points`);
        else if (detailPoints !== row.points) detailErrors.push(`${row.id}: points direct=${row.points} detail=${detailPoints}`);
        if (Number.isFinite(detailListedPointPrice) && Number.isFinite(row.listedPointPrice) && Math.abs(detailListedPointPrice - row.listedPointPrice) > 0.01) {
          detailErrors.push(`${row.id}: listed $/pt direct=${row.listedPointPrice} detail=${detailListedPointPrice}`);
        }
      } catch (error) {
        detailErrors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);

  if (detailErrors.length) {
    for (const error of detailErrors.slice(0, 25)) console.error(`DETAIL ${error}`);
    throw new Error(`${detailErrors.length} detail-page validation error(s)`);
  }
  console.log(`Detail-page validation: ${direct.length}/${direct.length} point totals agree with embedded structured data`);
  console.log(`VALIDATION PASSED with ${direct.length} current reservations`);
}

async function idsOnPage(page) {
  return page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => [...new Set(anchors.map(anchor => {
    const match = `${anchor.href} ${anchor.innerText || ""}`.match(/\bDVC\d+\b/i);
    return match ? match[0].toUpperCase() : null;
  }).filter(Boolean))]);
}

function compareSets(label, expected, actual) {
  const missing = [...expected].filter(id => !actual.has(id));
  const extra = [...actual].filter(id => !expected.has(id));
  if (missing.length || extra.length) {
    if (missing.length) console.error(`${label} missing: ${missing.slice(0, 20).join(", ")}`);
    if (extra.length) console.error(`${label} extra: ${extra.slice(0, 20).join(", ")}`);
    throw new Error(`${label} mismatch: expected ${expected.size}, got ${actual.size}`);
  }
  console.log(`${label}: exact match (${actual.size})`);
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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
