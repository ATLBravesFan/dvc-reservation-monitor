import { writeFile } from "node:fs/promises";
import { parseDvcRentalDealsHtml } from "../src/dvc-rental-direct.js";

const url = "https://dvc-rental.com/deals";
const response = await fetch(url, {
  headers: {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor-ReadOnly-Probe/1.0)",
  },
});
const html = await response.text();
await writeFile("dvc-rental-raw.html", html);

if (!response.ok) throw new Error(`DVC-Rental raw HTTP ${response.status}`);

const ids = [...new Set([...html.matchAll(/\bDVC\d+\b/gi)].map(m => m[0].toUpperCase()))];
const reported = Number(html.match(/(\d+)\s+confirmed reservations/i)?.[1] || NaN);
const rows = parseDvcRentalDealsHtml(html);
const parsedIds = new Set(rows.map(row => row.id));
const rawReservationIds = ids.filter(id => parsedIds.has(id) || html.includes(`\"id\":\"${id}\"`));
const missing = rawReservationIds.filter(id => !parsedIds.has(id));
const complete = rows.filter(row => row.id && row.checkIn && row.checkOut && Number.isFinite(row.nights) && Number.isFinite(row.total) && Number.isFinite(row.points)).length;

console.log("\n===== DVC-RENTAL RAW HTTP PROBE =====");
console.log(`HTTP ${response.status} content-type=${response.headers.get("content-type") || ""} bytes=${html.length}`);
console.log(`Reported count in raw response: ${Number.isFinite(reported) ? reported : "unknown"}`);
console.log(`Distinct DVC IDs in raw response: ${ids.length}`);
console.log(`Structured deals parsed: ${rows.length}`);
console.log(`Complete parsed rows (ID/dates/nights/total/points): ${complete}/${rows.length}`);
console.log(`Missing structured IDs: ${missing.length ? missing.join(", ") : "none"}`);

if (!rows.length) throw new Error("Direct parser returned zero DVC-Rental reservations");
if (complete !== rows.length) throw new Error(`Direct parser completeness failed: ${complete}/${rows.length}`);
if (missing.length) throw new Error(`Direct parser missed structured reservation IDs: ${missing.join(", ")}`);
if (Number.isFinite(reported) && rows.length !== reported) {
  throw new Error(`Direct parser count mismatch: site reports ${reported}, parsed ${rows.length}`);
}

console.log("Direct DVC-Rental parser LIVE verification PASSED");
console.log(`Sample: ${JSON.stringify(rows.slice(0, 3), null, 2)}`);
