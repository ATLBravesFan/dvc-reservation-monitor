import { chromium } from "playwright-core";

const BASE_URL = process.env.DVC_MONITOR_BASE_URL;
const TOKEN = process.env.DVC_MONITOR_INGEST_TOKEN;
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const JOB = process.env.DVC_BROWSER_JOB || "all";

if (!BASE_URL || !TOKEN) throw new Error("DVC_MONITOR_BASE_URL and DVC_MONITOR_INGEST_TOKEN are required");
if (!new Set(["all", "rental-store", "dvc-rental"]).has(JOB)) throw new Error(`Unknown DVC_BROWSER_JOB: ${JOB}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

try {
  if (JOB === "all" || JOB === "rental-store") {
    const rentalStore = await scrapeRentalStore(context);
    console.log(`DVC Rental Store website: ${rentalStore.length} usable reservations`);
    if (!rentalStore.length) throw new Error("DVC Rental Store website backup returned zero reservations");
    await ingest("/ingest/dvc-rental-store-website", rentalStore);
  }

  if (JOB === "all" || JOB === "dvc-rental") {
    const dvcRental = await scrapeDvcRental(context);
    console.log(`DVC-Rental: ${dvcRental.length} reservations across all pages`);
    await ingest("/ingest/dvc-rental", dvcRental);
  }
} finally {
  await browser.close();
}

async function scrapeRentalStore(context) {
  const page = await context.newPage();
  const captured = [];

  page.on("response", async response => {
    try {
      const contentType = response.headers()["content-type"] || "";
      if (!/json/i.test(contentType)) return;
      collectReservationObjects(await response.json(), captured);
    } catch {
      // Ignore transient response-body failures.
    }
  });

  await page.goto("https://dvcrentalstore.com/guests/browse-confirmed-reservations/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(8000);

  const rendered = await page.locator('a[href*="/guests/reservations/"]').evaluateAll(anchors => anchors.map(anchor => {
    const href = anchor.href;
    let node = anchor;
    let text = (anchor.innerText || "").trim();
    for (let index = 0; index < 7 && node?.parentElement; index += 1) {
      node = node.parentElement;
      const candidate = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (candidate.length > text.length && candidate.length < 1800) text = candidate;
      if (/\$[\d,]+/.test(candidate) && /\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}/.test(candidate)) break;
    }
    return { href, text };
  }));

  for (const row of rendered) {
    const parsed = parseRenderedRentalStore(row);
    if (parsed) captured.push(parsed);
  }

  await page.close();
  return dedupe(captured.map(normalizeRentalStoreObject).filter(Boolean));
}

function collectReservationObjects(value, out, depth = 0) {
  if (depth > 9 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectReservationObjects(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const id = first(value.reservationID, value.reservationId, value.reservation_id, value.id, value.Id, value.sfid);
  if (id && /^a0f[a-z0-9]+$/i.test(String(id))) out.push(value);
  for (const child of Object.values(value)) collectReservationObjects(child, out, depth + 1);
}

function normalizeRentalStoreObject(row) {
  const id = first(row.id, row.reservationID, row.reservationId, row.reservation_id, row.Id, row.sfid);
  if (!id || !/^a0f[a-z0-9]+$/i.test(String(id))) return null;

  const checkIn = dateOnly(first(row.checkIn, row.checkInString, row.check_in, row.startDate, row.arrivalDate));
  const checkOut = dateOnly(first(row.checkOut, row.checkOutString, row.check_out, row.endDate, row.departureDate));
  const nights = numberFirst(row.nights, row.numberOfNights, row.number_of_nights, diffNights(checkIn, checkOut));
  const total = numberFirst(row.total, row.price, row.totalPrice, row.total_price, row.totalCost, row.cost);
  const points = numberFirst(row.points, row.totalPoints, row.total_points);
  const nightly = numberFirst(row.nightly, row.pricePerNight, row.nightlyPrice, divide(total, nights));
  const pointPrice = numberFirst(row.pointPrice, row.pricePerPoint, row.price_per_point, divide(total, points));

  return {
    id: String(id),
    resort: clean(first(row.resort, row.resortName, row.resort_name)),
    room: clean(first(row.room, row.roomType, row.roomName, row.room_type)),
    checkIn,
    checkOut,
    nights,
    total,
    points,
    nightly,
    pointPrice,
    status: first(row.status) || "Available",
    bookingUrl: row.bookingUrl || `https://dvcrentalstore.com/guests/reservations/${encodeURIComponent(id)}/`,
  };
}

function parseRenderedRentalStore(row) {
  const id = row.href.match(/\/guests\/reservations\/(a0f[A-Za-z0-9]+)/i)?.[1];
  if (!id) return null;
  const text = clean(row.text);
  const dates = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\s*(?:→|-|to)\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
  const prices = [...text.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map(match => number(match[1])).filter(Number.isFinite);
  const nights = number(text.match(/(\d+)\s*nights?/i)?.[1]);
  const total = prices.length ? Math.max(...prices) : null;
  return {
    id,
    checkIn: dates ? dateOnly(dates[1]) : null,
    checkOut: dates ? dateOnly(dates[2]) : null,
    nights,
    total,
    nightly: divide(total, nights),
    bookingUrl: row.href,
  };
}

async function scrapeDvcRental(context) {
  const page = await context.newPage();
  await page.goto("https://dvc-rental.com/deals", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  const bodyText = await page.locator("body").innerText();
  const expected = number(
    bodyText.match(/Showing\s+\d+\s*[–-]\s*\d+\s+of\s+(\d+)/i)?.[1] ||
    bodyText.match(/(\d+)\s+confirmed reservations/i)?.[1],
  );
  const pageSize = number(bodyText.match(/Showing\s+\d+\s*[–-]\s*(\d+)\s+of\s+\d+/i)?.[1]) || 50;
  const totalPages = Number.isFinite(expected) ? Math.max(1, Math.ceil(expected / pageSize)) : 2;

  const rows = [];
  rows.push(...await collectDvcRentalPage(page));

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const pageButton = page.getByRole("button", { name: new RegExp(`^${pageNumber}$`) }).last();
    if (!(await pageButton.count())) {
      if (Number.isFinite(expected)) throw new Error(`DVC-Rental pagination button ${pageNumber} was not found`);
      break;
    }
    await pageButton.click();
    await page.waitForTimeout(1500);
    rows.push(...await collectDvcRentalPage(page));
  }

  await page.close();
  const unique = dedupe(rows);
  if (!unique.length) throw new Error("DVC-Rental browser parser returned zero reservations");
  if (Number.isFinite(expected) && unique.length < expected) {
    throw new Error(`DVC-Rental snapshot incomplete: expected ${expected}, parsed ${unique.length}. Snapshot was not ingested.`);
  }
  return unique;
}

async function collectDvcRentalPage(page) {
  const cards = await page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => anchors.map(anchor => ({
    href: anchor.href,
    text: (anchor.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  return cards.map(parseDvcRentalCard).filter(Boolean);
}

function parseDvcRentalCard(card) {
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

async function ingest(path, listings) {
  const url = new URL(path, BASE_URL).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ listings }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} ingest failed ${response.status}: ${body.slice(0, 500)}`);
  console.log(`${path}: ${body.slice(0, 800)}`);
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

function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function first(...values) { for (const value of values) if (value !== undefined && value !== null && String(value).trim()) return value; return null; }
function numberFirst(...values) { for (const value of values) { const parsed = number(value); if (Number.isFinite(parsed)) return parsed; } return null; }
function number(value) { if (value === undefined || value === null || value === "") return null; const parsed = Number(String(value).replace(/[$,\s]/g, "")); return Number.isFinite(parsed) ? parsed : null; }
function divide(a, b) { return Number.isFinite(a) && Number.isFinite(b) && b ? a / b : null; }
function diffNights(a, b) { if (!a || !b) return null; const nights = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); return nights > 0 ? nights : null; }
function dateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  const exactIso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (exactIso) return exactIso[1];
  const slash = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  const date = new Date(`${text} 12:00:00 UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
